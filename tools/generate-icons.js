#!/usr/bin/env node

/**
 * Generate PNG icons from SVG source.
 * Usage: npm install --no-save @resvg/resvg-js && node tools/generate-icons.js
 */

const { Resvg } = require("@resvg/resvg-js");
const path = require("path");
const fs = require("fs");

const SIZES = [16, 32, 48, 96, 128];
const SVG_PATH = path.join(__dirname, "..", "src", "icons", "icon-48.svg");
const OUT_DIR = path.join(__dirname, "..", "src", "icons");

const svg = fs.readFileSync(SVG_PATH, "utf8");

for (const size of SIZES) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
  });
  const png = resvg.render().asPng();
  const outPath = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Generated ${path.relative(process.cwd(), outPath)} (${size}x${size})`);
}

console.log("Done.");
