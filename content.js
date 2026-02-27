(function () {
  "use strict";

  const LOG = (...args) => console.log("[GR Shelf Position]", ...args);

  // --- Cache TTL (configurable via extension options) ---
  const DEFAULT_TTL_HOURS = 168;
  let cacheTtlMs = DEFAULT_TTL_HOURS * 60 * 60 * 1000;

  browser.storage.local.get("cacheTtlHours").then((result) => {
    if (result.cacheTtlHours != null) {
      cacheTtlMs = result.cacheTtlHours * 60 * 60 * 1000;
      LOG("Cache TTL set to", result.cacheTtlHours, "hours");
    }
  });

  // --- Constants ---
  const MAX_SHELF_PAGES = 50;
  const ITEMS_PER_PAGE = 100;
  const PAGINATION_DELAY_MS = 200;
  const OBSERVER_DEBOUNCE_MS = 1000;
  const SAVE_FLASH_MS = 2000;

  /** Returns true if value is a positive integer (string or number). */
  function isValidPosition(value) {
    return /^\d+$/.test(String(value)) && parseInt(value, 10) >= 1;
  }

  // Guard against double injection (SPA navigation can re-trigger content scripts)
  if (document.getElementById("gr-book-pos-widget")) return;

  // --- Step 1: Extract book ID from URL ---

  const bookIdMatch = window.location.pathname.match(/\/book\/show\/(\d+)/);
  if (!bookIdMatch) return;
  const bookId = bookIdMatch[1];
  LOG("Book ID:", bookId);

  // --- Step 2: Extract book title ---

  function getBookTitle() {
    let title = null;

    // Primary: og:title meta tag (stable across layouts)
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) {
      const content = ogTitle.getAttribute("content");
      if (content) title = content.trim();
    }

    // Fallback: page <title> — "Book Title by Author Name | Goodreads"
    if (!title && document.title) {
      const titleMatch = document.title.match(/^(.+?)\s+by\s+/);
      if (titleMatch) title = titleMatch[1].trim();
    }

    if (!title) return null;

    // Strip trailing ellipsis — og:title often truncates long titles
    title = title.replace(/\u2026$/, "").replace(/\.\.\.$/, "").trim();

    return title;
  }

  // --- Step 3: Discover user ID + CSRF token ---
  // Modern Goodreads book pages don't include CurrentUserStore in inline scripts,
  // so we first check the current page, then fall back to fetching the homepage.

  function getUserIdFromPage(doc) {
    const scripts = doc.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent;
      const match = text.match(
        /CurrentUserStore\.initializeWith\(\s*\{[^}]*"profileUrl"\s*:\s*"\/user\/show\/(\d+)/
      );
      if (match) return match[1];
    }
    return null;
  }

  function getCsrfFromPage(doc) {
    const meta = doc.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : null;
  }

  const USER_ID_CACHE_KEY = "gr-book-pos-userid";

  async function discoverUserIdAndCsrf() {
    // Try current page first
    let userId = getUserIdFromPage(document);
    let csrf = getCsrfFromPage(document);
    if (userId && csrf) {
      LOG("Found user ID + CSRF on current page");
      localStorage.setItem(USER_ID_CACHE_KEY, userId);
      return { userId, csrf };
    }

    // Check cached user ID — avoids slow homepage fetch on repeat visits.
    // CSRF still needed from homepage, but we can skip parsing for user ID.
    const cachedUserId = localStorage.getItem(USER_ID_CACHE_KEY);
    if (cachedUserId) {
      LOG("User ID from cache:", cachedUserId);
      userId = cachedUserId;
    }

    // Need CSRF token (and possibly user ID) from homepage
    if (!csrf) {
      LOG(userId
        ? "Fetching homepage for CSRF token..."
        : "Fetching homepage to discover user ID (this may take a few seconds)...");
      try {
        const t0 = Date.now();
        const resp = await fetch("https://www.goodreads.com/", {
          credentials: "same-origin",
        });
        if (!resp.ok) throw new Error(`Homepage HTTP ${resp.status}`);
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        LOG(`Homepage fetched in ${Date.now() - t0}ms`);

        if (!userId) userId = getUserIdFromPage(doc);
        csrf = getCsrfFromPage(doc);
      } catch (err) {
        LOG("Homepage fetch failed:", err);
        return null;
      }
    }

    if (userId) {
      localStorage.setItem(USER_ID_CACHE_KEY, userId);
      LOG("User ID:", userId);
      return { userId, csrf };
    }

    return null;
  }

  // --- Step 4: Cache layer (localStorage) ---
  // Stores reviewId -> { shelfId, position } for all books seen during pagination.
  // On subsequent visits to any book page, cache is checked first — skipping phase 2.
  // Shared with goodreads-position-fixer if same user.

  function cacheKey(userId) {
    return `gr-pos-fixer-${userId}`;
  }

  function loadCache(userId) {
    try {
      const raw = localStorage.getItem(cacheKey(userId));
      if (!raw) return new Map();

      // Check TTL
      const ts = localStorage.getItem(cacheKey(userId) + "-ts");
      if (cacheTtlMs > 0 && (!ts || Date.now() - Number(ts) > cacheTtlMs)) {
        LOG("Cache expired — clearing");
        localStorage.removeItem(cacheKey(userId));
        localStorage.removeItem(cacheKey(userId) + "-ts");
        return new Map();
      }

      return new Map(Object.entries(JSON.parse(raw)));
    } catch (e) {
      LOG("Cache read failed:", e);
      return new Map();
    }
  }

  function saveCache(userId, cache) {
    try {
      localStorage.setItem(cacheKey(userId), JSON.stringify(Object.fromEntries(cache)));
      localStorage.setItem(cacheKey(userId) + "-ts", String(Date.now()));
    } catch (e) {
      LOG("Cache write failed:", e);
    }
  }

  // --- Step 5: Find book on To Read shelf ---
  // Two-phase approach:
  //   Phase 1: Title search to confirm book is on shelf + get review ID (fast, 1 request)
  //   Phase 2: Check cache, then paginate non-search shelf view to get shelf ID + position
  //            (search results don't include position inputs)

  function cleanTitle(title) {
    // Strip series info in parens, e.g. "The Hobbit (The Lord of the Rings, #0)"
    return title.replace(/\s*\([^)]*#\d+[^)]*\)\s*$/, "").trim();
  }

  async function findReviewId(userId, searchTitle) {
    const url =
      `https://www.goodreads.com/review/list/${userId}?shelf=to-read` +
      `&view=table&search[query]=${encodeURIComponent(searchTitle)}`;

    LOG("Phase 1 — searching shelf for:", searchTitle);

    const resp = await fetch(url, { credentials: "same-origin" });
    if (!resp.ok) throw new Error(`Shelf search HTTP ${resp.status}`);

    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    const rows = doc.querySelectorAll("#booksBody tr.bookalike.review");
    for (const row of rows) {
      const bookLink = row.querySelector("td.field.title a");
      if (!bookLink) continue;
      const href = bookLink.getAttribute("href") || "";
      if (!href.match(new RegExp(`/book/show/${bookId}\\b`))) continue;

      // Extract review ID from row id="review_{ID}" or checkbox
      const rowMatch = row.id.match(/^review_(\d+)$/);
      if (rowMatch) return rowMatch[1];

      const checkbox = row.querySelector('input[name^="reviews["]');
      if (checkbox) {
        const cbMatch = checkbox.name.match(/^reviews\[(\d+)\]$/);
        if (cbMatch) return cbMatch[1];
      }
    }

    return null;
  }

  function parsePageRows(doc, cache) {
    const rows = doc.querySelectorAll("#booksBody tr.bookalike.review");
    rows.forEach((row) => {
      const rowMatch = row.id.match(/^review_(\d+)$/);
      if (!rowMatch) return;
      const revId = rowMatch[1];
      const posInput = row.querySelector('input[name^="positions["]');
      if (!posInput) return;
      const nameMatch = posInput.name.match(/^positions\[(\d+)\]$/);
      if (!nameMatch) return;
      const posValue = posInput.value || "";
      if (posValue !== "" && !isValidPosition(posValue)) return;
      cache.set(revId, { shelfId: nameMatch[1], position: posValue });
    });
    return rows.length;
  }

  async function findShelfData(userId, reviewId, onProgress) {
    // Check cache first
    const cache = loadCache(userId);
    LOG("Cache has", cache.size, "entries");

    if (cache.has(reviewId)) {
      LOG("Phase 2 — cache hit for review", reviewId);
      return { ...cache.get(reviewId) };
    }

    LOG("Phase 2 — paginating shelf for review", reviewId);

    // Paginate the shelf sorted by date_added (newest first) — recently added
    // books appear on page 1, and position inputs are present in non-search views.
    // Cache ALL rows seen so future book pages are instant.
    const maxPages = MAX_SHELF_PAGES;
    let result = null;
    let totalPages = null;

    for (let page = 1; page <= maxPages; page++) {
      if (onProgress) onProgress(page, totalPages);
      const url =
        `https://www.goodreads.com/review/list/${userId}?shelf=to-read` +
        `&sort=date_added&order=d&per_page=${ITEMS_PER_PAGE}&page=${page}&view=table`;

      const resp = await fetch(url, { credentials: "same-origin" });
      if (!resp.ok) throw new Error(`Shelf page ${page} HTTP ${resp.status}`);

      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, "text/html");

      // Parse total book count from page 1 to enable percentage progress
      if (page === 1 && !totalPages) {
        const titleEl = doc.querySelector("title");
        const countMatch = titleEl?.textContent?.match(/\(([\d,]+)\s+books?\)/);
        if (countMatch) {
          const totalBooks = parseInt(countMatch[1].replace(/,/g, ""), 10);
          totalPages = Math.ceil(totalBooks / ITEMS_PER_PAGE);
          LOG("Total books:", totalBooks, "— estimated pages:", totalPages);
        }
      }

      const rowCount = parsePageRows(doc, cache);
      if (rowCount === 0) break;

      if (cache.has(reviewId) && !result) {
        result = { ...cache.get(reviewId) };
        LOG("Found on page", page);
        // Keep paginating to fill cache, but stop after this page
        saveCache(userId, cache);
        return result;
      }

      LOG("Page", page, "—", rowCount, "rows, not found yet");

      // Small delay between pages to be polite
      if (page < maxPages) {
        await new Promise((resolve) => setTimeout(resolve, PAGINATION_DELAY_MS));
      }
    }

    // Save whatever we cached even if book wasn't found
    saveCache(userId, cache);
    return result ? result : null;
  }

  // --- Step 6: Widget lifecycle (loading → loaded / empty / error) ---

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function findAnchor() {
    const anchor =
      document.querySelector(".BookActions") ||
      document.querySelector(".wtrButtonContainer") ||
      document.querySelector("[data-testid='shelfButton']") ||
      document.querySelector(".BookPage__bookActions");

    if (anchor) return { el: anchor, prepend: false };

    // Last resort: look for the "Want to Read" button area
    const wtrBtn = document.querySelector(
      'button[aria-label*="Want to Read"], button[aria-label*="want to read"]'
    );
    if (wtrBtn) {
      const parent = wtrBtn.closest("div");
      if (parent) return { el: parent, prepend: false };
    }

    LOG("Could not find anchor element for widget. Injecting into page.");
    const main =
      document.querySelector("main") ||
      document.querySelector('[class*="BookPage"]') ||
      document.body;
    return { el: main, prepend: true };
  }

  function createNameElement() {
    const name = document.createElement("span");
    name.className = "gr-book-pos-name";
    name.textContent = "To Read Position";
    return name;
  }

  function transitionToLoading(widget) {
    clearChildren(widget);
    widget.classList.remove("gr-book-pos-empty");

    const spinner = document.createElement("span");
    spinner.className = "gr-book-pos-spinner";

    const status = document.createElement("span");
    status.className = "gr-book-pos-status";
    status.textContent = "Loading\u2026";

    widget.appendChild(createNameElement());
    widget.appendChild(spinner);
    widget.appendChild(status);
  }

  function injectLoadingWidget() {
    const { el: anchor, prepend } = findAnchor();

    const widget = document.createElement("div");
    widget.id = "gr-book-pos-widget";

    transitionToLoading(widget);

    if (prepend && anchor.firstChild) {
      anchor.insertBefore(widget, anchor.firstChild);
    } else {
      anchor.insertAdjacentElement("afterend", widget);
    }

    LOG("Loading widget injected");
    return widget;
  }

  function updateWidgetStatus(widget, text) {
    const status = widget.querySelector(".gr-book-pos-status");
    if (status) status.textContent = text;
  }

  function transitionToLoaded(widget, shelfId, position, userId, authToken, reviewId) {
    clearChildren(widget);

    const label = document.createElement("span");
    label.className = "gr-book-pos-label";
    label.textContent = "Position:";

    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.className = "gr-book-pos-input";
    input.value = position;
    input.dataset.shelfId = shelfId;
    input.dataset.originalValue = position;
    input.dataset.reviewId = reviewId;
    input.placeholder = "#";

    const saveBtn = document.createElement("button");
    saveBtn.className = "gr-book-pos-save";
    saveBtn.textContent = "Save";
    saveBtn.disabled = true;

    input.addEventListener("input", () => {
      const val = input.value.trim();
      const invalid = val !== "" && (!/^\d+$/.test(val) || parseInt(val, 10) < 1);
      const changed = val !== input.dataset.originalValue;
      saveBtn.disabled = !changed || invalid;
      input.classList.toggle("gr-book-pos-changed", changed && !invalid);
      input.classList.toggle("gr-book-pos-error", invalid);
      if (!invalid) input.classList.remove("gr-book-pos-saved");
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!saveBtn.disabled) savePosition(input, saveBtn, userId, authToken);
      }
    });

    saveBtn.addEventListener("click", () => {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      savePosition(input, saveBtn, userId, authToken);
    });

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "gr-book-pos-refresh";
    refreshBtn.textContent = "\u21BB";
    refreshBtn.title = "Refresh position from shelf";

    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      refreshBtn.classList.add("gr-book-pos-spinning");

      localStorage.removeItem(cacheKey(userId));
      localStorage.removeItem(cacheKey(userId) + "-ts");
      LOG("Cache cleared — refreshing position");

      try {
        const result = await findShelfData(userId, reviewId);
        if (result) {
          input.value = result.position;
          input.dataset.originalValue = result.position;
          input.dataset.shelfId = result.shelfId;
          input.classList.remove("gr-book-pos-changed", "gr-book-pos-error");
          saveBtn.disabled = true;
          LOG("Refreshed position:", result.position);
        } else {
          LOG("Refresh: book not found in shelf data");
        }
      } catch (err) {
        LOG("Refresh failed:", err);
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove("gr-book-pos-spinning");
      }
    });

    widget.appendChild(createNameElement());
    widget.appendChild(label);
    widget.appendChild(input);
    widget.appendChild(saveBtn);
    widget.appendChild(refreshBtn);

    LOG("Widget loaded, current position:", position);
  }

  function transitionToNotOnShelf(widget) {
    clearChildren(widget);
    widget.classList.add("gr-book-pos-empty");

    const label = document.createElement("span");
    label.className = "gr-book-pos-label";
    label.textContent = "Not on your To Read shelf";

    const desc = document.createElement("span");
    desc.className = "gr-book-pos-empty-desc";
    desc.textContent = "Add this book to your To Read shelf to set its position";

    widget.appendChild(createNameElement());
    widget.appendChild(label);
    widget.appendChild(desc);

    LOG("Widget: not on shelf");
  }

  function transitionToError(widget, message, onRetry) {
    clearChildren(widget);

    const msg = document.createElement("span");
    msg.className = "gr-book-pos-error-msg";
    msg.textContent = message;

    widget.appendChild(createNameElement());
    widget.appendChild(msg);

    if (onRetry) {
      const retryBtn = document.createElement("button");
      retryBtn.className = "gr-book-pos-refresh";
      retryBtn.textContent = "\u21BB";
      retryBtn.title = "Retry";
      retryBtn.addEventListener("click", () => {
        retryBtn.disabled = true;
        retryBtn.classList.add("gr-book-pos-spinning");
        onRetry();
      });
      widget.appendChild(retryBtn);
    }

    LOG("Widget error:", message);
  }

  // --- Step 7: Observe shelf button for changes ---
  // When the widget shows "not on shelf", watch the shelf button container
  // for structural DOM changes (e.g. user clicks "Want to Read"). On change,
  // re-run the two-phase lookup to see if the book is now on the shelf.

  function setupShelfObserver(widget, userId, authToken, bookTitle) {
    const { el: anchor } = findAnchor();

    // Don't observe fallback anchors — they aren't shelf button containers
    if (
      anchor === document.body ||
      anchor === document.querySelector("main") ||
      anchor === document.querySelector('[class*="BookPage"]')
    ) {
      LOG("No shelf button container found for observation");
      return;
    }

    let debounceTimer = null;
    let checking = false;
    let recheckNeeded = false;
    let userClicked = false;

    // Only react to mutations after the user clicks in the shelf button area.
    // This filters out Goodreads' own hydration/React renders which cause
    // structural DOM changes on every page load.
    anchor.addEventListener("click", () => { userClicked = true; });

    async function recheck() {
      checking = true;
      LOG("Shelf button changed \u2014 rechecking\u2026");

      transitionToLoading(widget);

      // Clear cache — it won't have the newly added book
      localStorage.removeItem(cacheKey(userId));
      localStorage.removeItem(cacheKey(userId) + "-ts");

      try {
        // Phase 1: confirm book is now on shelf
        updateWidgetStatus(widget, "Searching shelf\u2026");
        let reviewId = await findReviewId(userId, bookTitle);

        if (!reviewId) {
          const cleaned = cleanTitle(bookTitle);
          if (cleaned !== bookTitle) {
            reviewId = await findReviewId(userId, cleaned);
          }
        }

        if (!reviewId) {
          LOG("Book still not on shelf after mutation");
          transitionToNotOnShelf(widget);
          return; // Keep observing
        }

        // Found on shelf — stop observing
        observer.disconnect();
        LOG("Book now on shelf, review ID:", reviewId);

        // Phase 2: get shelf ID + position
        updateWidgetStatus(widget, "Loading position\u2026");
        const result = await findShelfData(userId, reviewId, (page, totalPages) => {
          if (totalPages) {
            const pct = Math.round((page / totalPages) * 100);
            updateWidgetStatus(widget, "Loading position\u2026 " + pct + "%");
          } else {
            updateWidgetStatus(widget, "Loading position\u2026");
          }
        });

        if (result) {
          transitionToLoaded(widget, result.shelfId, result.position, userId, authToken, reviewId);
        } else {
          transitionToError(widget, "On your To Read shelf, but position data could not be loaded.", () => {
            localStorage.removeItem(cacheKey(userId));
            localStorage.removeItem(cacheKey(userId) + "-ts");
            window.location.reload();
          });
        }
      } catch (err) {
        LOG("Shelf re-check failed:", err);
        transitionToNotOnShelf(widget);
        // Keep observing — might be a transient error
      } finally {
        checking = false;
        // If mutations arrived while checking, do one more pass
        if (recheckNeeded) {
          recheckNeeded = false;
          recheck();
        }
      }
    }

    const observer = new MutationObserver(() => {
      if (!userClicked) return;
      if (checking) {
        recheckNeeded = true;
        return;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(recheck, OBSERVER_DEBOUNCE_MS);
    });

    observer.observe(anchor, { childList: true, subtree: true });
    LOG("Observing shelf button for changes");
  }

  // --- Step 8: Save position ---

  async function savePosition(input, saveBtn, userId, authToken) {
    const val = input.value.trim();
    if (val !== "" && (!/^\d+$/.test(val) || parseInt(val, 10) < 1)) {
      input.classList.add("gr-book-pos-error");
      return;
    }

    const shelfId = input.dataset.shelfId;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    const params = new URLSearchParams();
    if (val !== "") {
      params.append(`positions[${shelfId}]`, val);
    }
    params.append("view", "table");
    params.append("authenticity_token", authToken);

    try {
      const resp = await fetch(
        `https://www.goodreads.com/shelf/move_batch/${userId}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-Token": authToken,
          },
          body: params.toString(),
        }
      );

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      // Response may be JSON (with updated positions) or HTML (success but no data)
      const text = await resp.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (e) {
        LOG("Response is not JSON (length:", text.length + "), treating as success");
      }

      // Update with server-confirmed position if available
      if (data && data.shelves) {
        const shelf = data.shelves.find((s) => String(s.id) === shelfId);
        if (shelf && isValidPosition(shelf.position)) {
          input.value = String(shelf.position);
          input.dataset.originalValue = String(shelf.position);
        } else {
          input.dataset.originalValue = val;
        }
      } else {
        // Server accepted but didn't return JSON — trust the value we sent
        input.dataset.originalValue = val;
      }

      // Clear cache — other books' positions shifted, so cache is stale
      localStorage.removeItem(cacheKey(userId));
      localStorage.removeItem(cacheKey(userId) + "-ts");

      input.classList.remove("gr-book-pos-changed");
      input.classList.add("gr-book-pos-saved");
      LOG("Position saved:", input.value);

      setTimeout(() => input.classList.remove("gr-book-pos-saved"), SAVE_FLASH_MS);
    } catch (err) {
      LOG("Save failed:", err);
      input.classList.add("gr-book-pos-error");
    } finally {
      saveBtn.textContent = "Save";
      saveBtn.disabled = input.value === input.dataset.originalValue;
    }
  }

  // --- Run ---

  (async function run() {
    const bookTitle = getBookTitle();
    LOG("Book title:", bookTitle);

    if (!bookTitle) {
      LOG("Could not determine book title. Skipping.");
      return;
    }

    const widget = injectLoadingWidget();

    try {
      const auth = await discoverUserIdAndCsrf();
      if (!auth || !auth.userId) {
        transitionToError(widget, "Not logged in \u2014 log in to Goodreads to use this extension");
        return;
      }
      if (!auth.csrf) {
        transitionToError(widget, "Could not load shelf data", () => window.location.reload());
        return;
      }

      const { userId, csrf: authToken } = auth;
      LOG("User ID:", userId, "\u2014 looking up shelf position...");

      // Phase 1: Title search to confirm book is on shelf and get review ID
      updateWidgetStatus(widget, "Searching shelf\u2026");
      let reviewId = await findReviewId(userId, bookTitle);

      // Retry with cleaned title if needed
      if (!reviewId) {
        const cleaned = cleanTitle(bookTitle);
        if (cleaned !== bookTitle) {
          LOG("Retrying with cleaned title:", cleaned);
          reviewId = await findReviewId(userId, cleaned);
        }
      }

      if (!reviewId) {
        LOG("Book not found on To Read shelf.");
        transitionToNotOnShelf(widget);
        setupShelfObserver(widget, userId, authToken, bookTitle);
        return;
      }

      LOG("Review ID:", reviewId);

      // Phase 2: Paginate non-search shelf view to get shelf ID + position
      updateWidgetStatus(widget, "Loading position\u2026");
      const result = await findShelfData(userId, reviewId, (page, totalPages) => {
        if (totalPages) {
          const pct = Math.round((page / totalPages) * 100);
          updateWidgetStatus(widget, "Loading position\u2026 " + pct + "%");
        } else {
          updateWidgetStatus(widget, "Loading position\u2026");
        }
      });

      if (!result) {
        LOG("Could not find shelf data for review", reviewId,
          "\u2014 book is on shelf but position data not found (shelf may exceed pagination limit)");
        transitionToError(widget, "On your To Read shelf, but position data could not be loaded.", () => {
          localStorage.removeItem(cacheKey(userId));
          localStorage.removeItem(cacheKey(userId) + "-ts");
          window.location.reload();
        });
        return;
      }

      LOG("Found \u2014 shelfId:", result.shelfId, "position:", result.position);
      transitionToLoaded(widget, result.shelfId, result.position, userId, authToken, reviewId);
    } catch (err) {
      LOG("Error:", err);
      transitionToError(widget, "Something went wrong", () => window.location.reload());
    }
  })();
})();
