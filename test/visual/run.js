const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { Builder, By, until } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");
const geckodriver = require("geckodriver");

const { startServer } = require("./server");
const scenarios = require("./scenarios");
const seedData = require("../fixtures/seed-data");

const SRC_DIR = path.join(__dirname, "..", "..", "src");
const SCREENSHOTS_DIR = path.join(__dirname, "..", "screenshots");
const WAIT_TIMEOUT_MS = 10000;
const GECKODRIVER_PORT = 4444;

// --- Prepare patched extension in a temp directory ---

function preparePatchedExtension(port) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gr-shelf-pos-test-"));

  // Copy all src/ files to temp dir (preserving directory structure)
  copyDirSync(SRC_DIR, tmpDir);

  // Patch manifest.json — add localhost to content_scripts matches and host_permissions
  const manifestPath = path.join(tmpDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  manifest.content_scripts[0].matches.push("*://localhost/*");
  manifest.content_scripts[0].matches.push("*://127.0.0.1/*");
  manifest.host_permissions.push("*://localhost/*");
  manifest.host_permissions.push("*://127.0.0.1/*");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Patch content.js — redirect Goodreads URLs to local fixture server
  const contentPath = path.join(tmpDir, "content.js");
  let content = fs.readFileSync(contentPath, "utf-8");
  content = content.replace(
    /https:\/\/www\.goodreads\.com\//g,
    `http://127.0.0.1:${port}/`
  );
  fs.writeFileSync(contentPath, content);

  return tmpDir;
}

function copyDirSync(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function rmDirSync(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Main orchestrator ---

async function run() {
  console.log("Starting visual test runner...\n");

  // 1. Kill orphaned geckodriver processes that can block startup
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/IM", "geckodriver.exe"], { stdio: "ignore" });
    } else {
      execFileSync("pkill", ["-f", "geckodriver"], { stdio: "ignore" });
    }
  } catch (_) {} // Fine if none found

  // 2. Start fixture server
  const { server, port } = await startServer();
  console.log(`Fixture server listening on http://127.0.0.1:${port}`);

  // 3. Prepare patched extension
  const extDir = preparePatchedExtension(port);
  console.log(`Patched extension at: ${extDir}`);

  // 4. Ensure screenshots directory exists
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // 5. Start geckodriver ourselves (avoids Selenium Manager hangs)
  console.log("Starting geckodriver...");
  const geckodriverProcess = await geckodriver.start({ port: GECKODRIVER_PORT });
  console.log(`Geckodriver running on port ${GECKODRIVER_PORT} (PID ${geckodriverProcess.pid})`);

  // Small delay to ensure geckodriver is ready to accept connections
  await new Promise((r) => setTimeout(r, 500));

  // 6. Launch Firefox
  let driver;
  try {
    const options = new firefox.Options();
    // Default to visible browser; set HEADLESS=true for CI or headless environments
    if (process.env.HEADLESS === "true") {
      options.addArguments("-headless");
    }
    // Set a consistent window size for reproducible screenshots
    options.addArguments("-width=800");
    options.addArguments("-height=900");

    console.log("Launching Firefox...");
    driver = await new Builder()
      .forBrowser("firefox")
      .usingServer(`http://127.0.0.1:${GECKODRIVER_PORT}`)
      .setFirefoxOptions(options)
      .build();
    console.log("Firefox launched");

    // Install the patched extension as a temporary addon
    console.log("Installing extension...");
    await driver.installAddon(extDir, true);
    console.log("Extension installed\n");

    // 7. Run each scenario
    const results = [];
    for (const scenario of scenarios) {
      const result = await runScenario(driver, port, scenario);
      results.push(result);
    }

    // 8. Print summary
    console.log("\n--- Summary ---");
    let allPassed = true;
    for (const r of results) {
      const icon = r.success ? "PASS" : "FAIL";
      console.log(`  [${icon}] ${r.name}: ${r.message}`);
      if (!r.success) allPassed = false;
    }
    console.log(`\nScreenshots saved to: ${SCREENSHOTS_DIR}`);

    if (!allPassed) process.exitCode = 1;
  } finally {
    if (driver) await driver.quit().catch(() => {});
    geckodriverProcess.kill();
    server.close();
    rmDirSync(extDir);
  }
}

async function runScenario(driver, port, scenario) {
  const { name, path: urlPath, seedKey, waitFor, description } = scenario;
  console.log(`Running: ${name} — ${description}`);

  try {
    // Navigate to blank page (same origin) for localStorage seeding
    await driver.get(`http://127.0.0.1:${port}/`);

    // Clear all localStorage, then seed for this scenario
    const entries = seedData[seedKey] || {};
    await driver.executeScript(`
      localStorage.clear();
      const entries = arguments[0];
      for (const [key, value] of Object.entries(entries)) {
        localStorage.setItem(key, value);
      }
    `, entries);

    // Navigate to the fixture page
    await driver.get(`http://127.0.0.1:${port}${urlPath}`);

    // Wait for the expected element to appear
    await driver.wait(until.elementLocated(By.css(waitFor)), WAIT_TIMEOUT_MS);

    // Small extra delay to let animations/transitions settle
    await driver.sleep(500);

    // Scroll the widget into view so it's visible in the screenshot
    await driver.executeScript(`
      const widget = document.getElementById("gr-book-pos-widget");
      if (widget) widget.scrollIntoView({ block: "center" });
    `);
    await driver.sleep(200);

    // Take screenshot
    const png = await driver.takeScreenshot();
    const screenshotPath = path.join(SCREENSHOTS_DIR, `${name}.png`);
    fs.writeFileSync(screenshotPath, png, "base64");

    console.log(`  -> Screenshot: ${screenshotPath}`);
    return { name, success: true, message: screenshotPath };
  } catch (err) {
    // Still try to grab a screenshot on failure for debugging
    try {
      const png = await driver.takeScreenshot();
      const screenshotPath = path.join(SCREENSHOTS_DIR, `${name}-error.png`);
      fs.writeFileSync(screenshotPath, png, "base64");
      console.log(`  -> Error screenshot: ${screenshotPath}`);
    } catch (_) {}

    console.error(`  -> FAILED: ${err.message}`);
    return { name, success: false, message: err.message };
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
