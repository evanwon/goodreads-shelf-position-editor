(function () {
  "use strict";

  const LOG = (...args) => console.log("[GR Shelf Position]", ...args);

  // --- Cache TTL (configurable via extension options) ---
  let cacheTtlMs = DEFAULT_TTL_HOURS * 60 * 60 * 1000;

  browser.storage.local.get("cacheTtlHours").then((result) => {
    if (result.cacheTtlHours != null) {
      cacheTtlMs = result.cacheTtlHours * 60 * 60 * 1000;
      LOG("Cache TTL set to", result.cacheTtlHours, "hours");
    }
  });

  // --- Constants ---
  // Shared constants (MAX_SHELF_PAGES, ITEMS_PER_PAGE, PAGINATION_DELAY_MS) → utils/shelf-api.js
  const OBSERVER_DEBOUNCE_MS = 1000;
  const SAVE_FLASH_MS = 2000;

  // Guard against double injection (SPA navigation can re-trigger content scripts)
  if (document.getElementById("gr-book-pos-widget")) return;

  // --- Step 1: Extract book ID from URL ---

  const bookId = extractBookId(window.location.pathname);
  if (!bookId) return;
  LOG("Book ID:", bookId);

  // --- Step 2–3: Discover user ID + CSRF token ---
  // getUserIdFromPage, getCsrfFromPage, getBookTitle → utils/parse.js
  // Modern Goodreads book pages don't include CurrentUserStore in inline scripts,
  // so we first check the current page, then fall back to fetching the homepage.

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

  // Cache functions (cacheKey, loadCache, saveCache, clearCache) → utils/cache.js

  // --- Step 5: Find book on To Read shelf ---
  // Two-phase approach:
  //   Phase 1: Title search to confirm book is on shelf + get review ID (fast, 1 request)
  //   Phase 2: Check cache, then paginate non-search shelf view to get shelf ID + position
  //            (search results don't include position inputs)

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

      // Goodreads search ignores the shelf= filter and returns books from
      // all shelves. Verify this book is actually on to-read before accepting.
      const shelfLinks = row.querySelectorAll("td.field.shelves a");
      const onToRead = Array.from(shelfLinks).some(
        (a) => a.textContent.trim() === "to-read"
      );
      if (!onToRead) {
        LOG("Book found in search but not on to-read shelf — skipping");
        continue;
      }

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

  // parsePageRows, findShelfData, findAllShelfData, saveBatchPosition → utils/shelf-api.js

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

  function transitionToLoaded(widget, shelfId, position, userId, authToken, reviewId, fromCache, cacheTimestamp) {
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

    widget.appendChild(createNameElement());
    widget.appendChild(label);
    widget.appendChild(input);
    widget.appendChild(saveBtn);

    // Cache indicator — only shown when data came from cache
    if (fromCache && cacheTimestamp) {
      const cacheInfo = document.createElement("span");
      cacheInfo.className = "gr-book-pos-cache-info";

      const ageText = document.createElement("span");
      ageText.textContent = "Cached " + formatRelativeTime(cacheTimestamp);

      const refreshLink = document.createElement("a");
      refreshLink.className = "gr-book-pos-refresh-link";
      refreshLink.textContent = "Refresh";
      refreshLink.href = "#";

      const spinner = document.createElement("span");
      spinner.className = "gr-book-pos-refresh-spinner";
      spinner.style.display = "none";

      refreshLink.addEventListener("click", async (e) => {
        e.preventDefault();
        if (refreshLink.dataset.loading === "true") return;
        refreshLink.dataset.loading = "true";
        refreshLink.style.display = "none";
        spinner.style.display = "inline-block";

        clearCache(userId);
        LOG("Cache cleared — refreshing position");

        try {
          const result = await findShelfData(userId, reviewId, cacheTtlMs);
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
          // Data is now fresh — hide the entire indicator
          cacheInfo.style.display = "none";
        } catch (err) {
          LOG("Refresh failed:", err);
          refreshLink.style.display = "";
        } finally {
          spinner.style.display = "none";
          refreshLink.dataset.loading = "false";
        }
      });

      cacheInfo.appendChild(ageText);
      cacheInfo.appendChild(document.createTextNode(" \u00B7 "));
      cacheInfo.appendChild(refreshLink);
      cacheInfo.appendChild(spinner);
      widget.appendChild(cacheInfo);
    }

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
      retryBtn.className = "gr-book-pos-retry";
      const retryIcon = document.createElement("span");
      retryIcon.className = "gr-book-pos-retry-icon";
      retryIcon.textContent = "\u21BB";
      retryBtn.appendChild(retryIcon);
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
      clearCache(userId);

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
        const result = await findShelfData(userId, reviewId, cacheTtlMs, (page, totalPages) => {
          if (totalPages) {
            const pct = Math.min(100, Math.round((page / totalPages) * 100));
            updateWidgetStatus(widget, "Loading position\u2026 " + pct + "%");
          } else {
            updateWidgetStatus(widget, "Loading position\u2026");
          }
        });

        if (result) {
          transitionToLoaded(widget, result.shelfId, result.position, userId, authToken, reviewId, false, null);
        } else {
          transitionToError(widget, "On your To Read shelf, but position data could not be loaded.", () => {
            clearCache(userId);
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

    try {
      const result = await saveBatchPosition(userId, shelfId, val, authToken);

      // Update with server-confirmed position if available
      if (result.confirmedPosition) {
        input.value = result.confirmedPosition;
        input.dataset.originalValue = result.confirmedPosition;
      } else {
        input.dataset.originalValue = val;
      }

      // Clear cache — other books' positions shifted, so cache is stale
      clearCache(userId);

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
    const bookTitle = getBookTitle(document);
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
      const result = await findShelfData(userId, reviewId, cacheTtlMs, (page, totalPages) => {
        if (totalPages) {
          const pct = Math.min(100, Math.round((page / totalPages) * 100));
          updateWidgetStatus(widget, "Loading position\u2026 " + pct + "%");
        } else {
          updateWidgetStatus(widget, "Loading position\u2026");
        }
      });

      if (!result) {
        LOG("Could not find shelf data for review", reviewId,
          "\u2014 book is on shelf but position data not found (shelf may exceed pagination limit)");
        transitionToError(widget, "On your To Read shelf, but position data could not be loaded.", () => {
          clearCache(userId);
          window.location.reload();
        });
        return;
      }

      LOG("Found \u2014 shelfId:", result.shelfId, "position:", result.position);
      transitionToLoaded(widget, result.shelfId, result.position, userId, authToken, reviewId, result.fromCache, result.cacheTimestamp);
    } catch (err) {
      LOG("Error:", err);
      transitionToError(widget, "Something went wrong", () => window.location.reload());
    }
  })();
})();
