(function () {
  "use strict";

  var LOG = function () {
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[GR Shelf Position]");
    console.log.apply(console, args);
  };

  // --- Cache TTL (configurable via extension options) ---
  var cacheTtlMs = DEFAULT_TTL_HOURS * 60 * 60 * 1000;

  browser.storage.local.get("cacheTtlHours").then(function (result) {
    if (result.cacheTtlHours != null) {
      cacheTtlMs = result.cacheTtlHours * 60 * 60 * 1000;
      LOG("Cache TTL set to", result.cacheTtlHours, "hours");
    }
  });

  // --- Constants ---
  var SAVE_FLASH_MS = 2000;
  var OBSERVER_DEBOUNCE_MS = 1000;
  var POSITION_COL_CLASS = "gr-shelf-pos-col";

  // Track recently saved reviews so refreshes/mutations don't overwrite optimistic values.
  // Maps reviewId -> { value, shelfId } for cells that were just saved.
  var justSavedReviews = new Map();

  // --- Step 1: Activation checks ---

  // Guard: skip if position column already injected
  if (document.querySelector("." + POSITION_COL_CLASS)) {
    LOG("Shelf: position column already injected, skipping");
    return;
  }

  // Parse URL: extract userId from path /review/list/{USER_ID}
  var pathMatch = window.location.pathname.match(/\/review\/list\/(\d+)/);
  if (!pathMatch) {
    LOG("Shelf: not a review list page, skipping");
    return;
  }
  var userId = pathMatch[1];

  // Check shelf=to-read in URL params (or default shelf)
  var urlParams = new URLSearchParams(window.location.search);
  var shelf = urlParams.get("shelf");
  if (shelf && shelf !== "to-read") {
    LOG("Shelf: not on to-read shelf (" + shelf + "), skipping");
    return;
  }

  // Check search[query] is present and non-empty
  var searchQuery = urlParams.get("search[query]");
  if (!searchQuery || !searchQuery.trim()) {
    LOG("Shelf: no search query, skipping (native controls work)");
    return;
  }

  // Check table #booksBody exists with rows
  var booksBody = document.getElementById("booksBody");
  if (!booksBody) {
    LOG("Shelf: no #booksBody found, skipping");
    return;
  }

  var rows = booksBody.querySelectorAll("tr.bookalike.review");
  if (rows.length === 0) {
    LOG("Shelf: no book rows found, skipping");
    return;
  }

  // Check rows do NOT have position inputs (confirming search stripped them)
  var hasPositionInputs = booksBody.querySelector('input[name^="positions["]');
  if (hasPositionInputs) {
    LOG("Shelf: rows already have position inputs, skipping");
    return;
  }

  LOG("Shelf: search mode detected, injecting position column for", rows.length, "rows");

  // --- Step 2: Auth ---
  var authToken = getCsrfFromPage(document);
  if (!authToken) {
    LOG("Shelf: no CSRF token found, cannot save positions");
    return;
  }

  // --- Step 3: Extract review IDs from search result rows ---

  function extractReviewIds() {
    var ids = [];
    var currentRows = booksBody.querySelectorAll("tr.bookalike.review");
    currentRows.forEach(function (row) {
      var rowMatch = row.id.match(/^review_(\d+)$/);
      if (!rowMatch) return;

      // Verify shelf is to-read
      var shelfLinks = row.querySelectorAll("td.field.shelves a");
      var onToRead = Array.from(shelfLinks).some(function (a) {
        return a.textContent.trim() === "to-read";
      });
      if (!onToRead) return;

      ids.push(rowMatch[1]);
    });
    return ids;
  }

  // --- Step 4: Inject position column ---

  function injectColumnHeader() {
    var headerRow = document.querySelector("#books thead tr");
    if (!headerRow) return;

    // Don't double-inject
    if (headerRow.querySelector("." + POSITION_COL_CLASS)) return;

    var th = document.createElement("th");
    th.className = POSITION_COL_CLASS + " header field position gr-shelf-pos-header";
    th.textContent = "#";
    th.title = "Position";

    var refHeader = headerRow.querySelector(".header.field.cover")
                 || headerRow.querySelector(".header.field.title");
    if (refHeader) {
      headerRow.insertBefore(th, refHeader);
    } else {
      headerRow.appendChild(th);
    }
  }

  function injectCellForRow(row) {
    // Don't double-inject
    if (row.querySelector("." + POSITION_COL_CLASS)) return null;

    var td = document.createElement("td");
    td.className = POSITION_COL_CLASS + " field position gr-shelf-pos-cell";

    // Loading state
    var spinner = document.createElement("span");
    spinner.className = "gr-shelf-pos-spinner";
    td.appendChild(spinner);

    var refCell = row.querySelector("td.field.cover")
              || row.querySelector("td.field.title");
    if (refCell) {
      row.insertBefore(td, refCell);
    } else {
      row.appendChild(td);
    }
    return td;
  }

  function injectAllCells() {
    var currentRows = booksBody.querySelectorAll("tr.bookalike.review");
    currentRows.forEach(function (row) {
      injectCellForRow(row);
    });
  }

  // --- Step 5: Load positions ---

  function createPositionEditor(cell, reviewId, shelfId, position) {
    // Clear cell
    while (cell.firstChild) cell.removeChild(cell.firstChild);

    var input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.className = "gr-shelf-pos-input";
    input.value = position;
    input.dataset.shelfId = shelfId;
    input.dataset.reviewId = reviewId;
    input.dataset.originalValue = position;
    input.placeholder = "#";

    // Tooltip (hidden by default) — matches native Goodreads Prototip "creamy" style
    var tooltip = document.createElement("div");
    tooltip.className = "gr-shelf-pos-tooltip";
    tooltip.style.display = "none";

    var stem = document.createElement("div");
    stem.className = "gr-shelf-pos-stem";

    var content = document.createElement("div");
    content.className = "gr-shelf-pos-tooltip-content";

    var saveLink = document.createElement("a");
    saveLink.href = "#";
    saveLink.className = "gr-shelf-pos-tooltip-save";
    saveLink.textContent = "Save position changes";

    var spacer = document.createTextNode("\u00a0\u00a0");

    var closeLink = document.createElement("a");
    closeLink.href = "#";
    closeLink.className = "gr-shelf-pos-tooltip-close";
    closeLink.textContent = "close";

    content.appendChild(saveLink);
    content.appendChild(spacer);
    content.appendChild(closeLink);
    tooltip.appendChild(stem);
    tooltip.appendChild(content);

    var tooltipVisible = false;

    function showTooltip() {
      if (tooltipVisible) return;
      tooltip.style.display = "";
      tooltipVisible = true;
    }

    function hideTooltip() {
      tooltip.style.display = "none";
      tooltipVisible = false;
    }

    function canSave() {
      var val = input.value.trim();
      var invalid = val !== "" && (!/^\d+$/.test(val) || parseInt(val, 10) < 1);
      var changed = val !== input.dataset.originalValue;
      return changed && !invalid;
    }

    input.addEventListener("input", function () {
      var val = input.value.trim();
      var invalid = val !== "" && (!/^\d+$/.test(val) || parseInt(val, 10) < 1);
      var changed = val !== input.dataset.originalValue;
      input.classList.toggle("gr-shelf-pos-changed", changed && !invalid);
      input.classList.toggle("gr-shelf-pos-error", invalid);
      if (!invalid) input.classList.remove("gr-shelf-pos-saved");
    });

    input.addEventListener("focus", function () {
      showTooltip();
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (canSave()) handleSave(input, tooltip);
      }
      if (e.key === "Escape") {
        input.value = input.dataset.originalValue;
        input.classList.remove("gr-shelf-pos-changed", "gr-shelf-pos-error");
        hideTooltip();
        input.blur();
      }
    });

    saveLink.addEventListener("click", function (e) {
      e.preventDefault();
      if (canSave()) handleSave(input, tooltip);
    });

    closeLink.addEventListener("click", function (e) {
      e.preventDefault();
      input.value = input.dataset.originalValue;
      input.classList.remove("gr-shelf-pos-changed", "gr-shelf-pos-error");
      hideTooltip();
      input.blur();
    });

    // Close tooltip on outside click
    document.addEventListener("mousedown", function (e) {
      if (tooltipVisible && !cell.contains(e.target)) {
        hideTooltip();
      }
    });

    var wrapper = document.createElement("span");
    wrapper.className = "gr-shelf-pos-wrapper";
    wrapper.appendChild(input);
    wrapper.appendChild(tooltip);
    cell.appendChild(wrapper);
  }

  function setCellDash(cell) {
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    cell.textContent = "\u2014";
    cell.classList.add("gr-shelf-pos-na");
  }

  async function loadPositions(reviewIds) {
    LOG("Shelf: loading positions for", reviewIds.length, "reviews");

    try {
      var results = await findAllShelfData(userId, reviewIds, cacheTtlMs);

      pauseObserver();
      var currentRows = booksBody.querySelectorAll("tr.bookalike.review");
      currentRows.forEach(function (row) {
        var rowMatch = row.id.match(/^review_(\d+)$/);
        if (!rowMatch) return;
        var rid = rowMatch[1];
        var cell = row.querySelector("." + POSITION_COL_CLASS);
        if (!cell) return;

        // Use optimistic value if this review was just saved
        if (justSavedReviews.has(rid)) {
          var saved = justSavedReviews.get(rid);
          createPositionEditor(cell, rid, saved.shelfId, saved.value);
        } else if (results.has(rid)) {
          var data = results.get(rid);
          createPositionEditor(cell, rid, data.shelfId, data.position);
        } else {
          setCellDash(cell);
        }
      });
      resumeObserver();

      LOG("Shelf: positions loaded for", results.size, "of", reviewIds.length, "reviews");
    } catch (err) {
      LOG("Shelf: failed to load positions:", err);
      // Show error state in all cells
      pauseObserver();
      var currentRows = booksBody.querySelectorAll("tr.bookalike.review");
      currentRows.forEach(function (row) {
        var cell = row.querySelector("." + POSITION_COL_CLASS);
        if (!cell) return;
        while (cell.firstChild) cell.removeChild(cell.firstChild);
        cell.textContent = "!";
        cell.title = "Failed to load position";
        cell.classList.add("gr-shelf-pos-error");
      });
      resumeObserver();
    }
  }

  // --- Step 6: Save handler ---

  async function handleSave(input, tooltip) {
    var val = input.value.trim();
    if (val !== "" && (!/^\d+$/.test(val) || parseInt(val, 10) < 1)) {
      input.classList.add("gr-shelf-pos-error");
      return;
    }

    var shelfId = input.dataset.shelfId;
    var originalVal = input.dataset.originalValue;

    // Determine the review ID from the closest row
    var row = input.closest("tr.bookalike.review");
    var rowMatch = row && row.id.match(/^review_(\d+)$/);
    var reviewId = rowMatch ? rowMatch[1] : null;

    // Immediate visual feedback: lock input + show saving state
    input.classList.add("gr-shelf-pos-saving");
    input.readOnly = true;
    tooltip.style.display = "none";

    // Register optimistic value BEFORE the await — protects against
    // mutation observer firing loadPositions during the save API call,
    // which would rebuild the cell and overwrite with stale data
    if (reviewId) {
      justSavedReviews.set(reviewId, { value: val, shelfId: shelfId });
    }

    try {
      var result = await saveBatchPosition(userId, shelfId, val, authToken);

      // Check if server adjusted position to something unexpected
      var finalVal = val;
      if (result.confirmedPosition
          && result.confirmedPosition !== val
          && result.confirmedPosition !== originalVal) {
        finalVal = result.confirmedPosition;
        LOG("Shelf: server adjusted position to", finalVal);
      }

      // Update the map with final value (may differ from initial optimistic)
      if (reviewId) {
        justSavedReviews.set(reviewId, { value: finalVal, shelfId: shelfId });
      }

      // Clear cache — other books' positions shifted
      clearCache(userId);

      // Re-query input from DOM — the original may have been replaced
      // by a mutation observer rebuild during the save await
      var freshCell = row.querySelector("." + POSITION_COL_CLASS);
      var freshInput = freshCell && freshCell.querySelector(".gr-shelf-pos-input");
      if (freshInput) {
        freshInput.value = finalVal;
        freshInput.dataset.originalValue = finalVal;
        freshInput.classList.remove("gr-shelf-pos-changed", "gr-shelf-pos-saving");
        freshInput.readOnly = false;
        freshInput.classList.add("gr-shelf-pos-saved");
        freshInput.blur();
        setTimeout(function () { freshInput.classList.remove("gr-shelf-pos-saved"); }, SAVE_FLASH_MS);
      }
      LOG("Shelf: position saved for shelf", shelfId, ":", finalVal);

      // Re-fetch positions for all visible rows (other positions shifted)
      refreshAllPositions();
    } catch (err) {
      LOG("Shelf: save failed:", err);
      // Remove optimistic entry on failure
      if (reviewId) justSavedReviews.delete(reviewId);
      // Re-query in case input was replaced
      var errCell = row.querySelector("." + POSITION_COL_CLASS);
      var errInput = errCell && errCell.querySelector(".gr-shelf-pos-input");
      if (errInput) {
        errInput.classList.remove("gr-shelf-pos-saving");
        errInput.readOnly = false;
        errInput.classList.add("gr-shelf-pos-error");
      }
    }
  }

  async function refreshAllPositions() {
    var reviewIds = extractReviewIds();
    if (reviewIds.length === 0) return;

    // Show refreshing state on cells that aren't freshly saved
    pauseObserver();
    var currentRows = booksBody.querySelectorAll("tr.bookalike.review");
    currentRows.forEach(function (row) {
      var rowMatch = row.id.match(/^review_(\d+)$/);
      if (rowMatch && justSavedReviews.has(rowMatch[1])) return;
      var cell = row.querySelector("." + POSITION_COL_CLASS);
      if (cell) cell.classList.add("gr-shelf-pos-refreshing");
    });
    resumeObserver();

    try {
      var results = await findAllShelfData(userId, reviewIds, cacheTtlMs);

      pauseObserver();
      currentRows = booksBody.querySelectorAll("tr.bookalike.review");
      currentRows.forEach(function (row) {
        var rowMatch = row.id.match(/^review_(\d+)$/);
        if (!rowMatch) return;
        var rid = rowMatch[1];
        var cell = row.querySelector("." + POSITION_COL_CLASS);
        if (!cell) return;

        cell.classList.remove("gr-shelf-pos-refreshing");

        // Skip cells with optimistic values from a recent save
        if (justSavedReviews.has(rid)) {
          justSavedReviews.delete(rid);
          return;
        }

        if (results.has(rid)) {
          var data = results.get(rid);
          var input = cell.querySelector(".gr-shelf-pos-input");
          if (input) {
            input.value = data.position;
            input.dataset.originalValue = data.position;
            input.dataset.shelfId = data.shelfId;
            input.classList.remove("gr-shelf-pos-changed", "gr-shelf-pos-error");
            var tooltip = cell.querySelector(".gr-shelf-pos-tooltip");
            if (tooltip) tooltip.style.display = "none";
          }
        }
      });
      resumeObserver();
    } catch (err) {
      LOG("Shelf: refresh failed:", err);
      // Clear refreshing state on error
      pauseObserver();
      var cells = booksBody.querySelectorAll("." + POSITION_COL_CLASS);
      cells.forEach(function (cell) { cell.classList.remove("gr-shelf-pos-refreshing"); });
      resumeObserver();
    }
  }

  // --- Step 7: Mutation observer on #booksBody ---
  // MutationObserver callbacks fire asynchronously, so a synchronous flag
  // can't suppress them. Instead, disconnect before our own DOM changes
  // and reconnect after.

  var debounceTimer = null;
  var observer;

  function pauseObserver() {
    if (observer) observer.disconnect();
  }

  function resumeObserver() {
    if (observer) observer.observe(booksBody, { childList: true, subtree: true });
  }

  function handleMutation() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      LOG("Shelf: rows changed, re-processing");
      var reviewIds = extractReviewIds();
      if (reviewIds.length === 0) return;

      pauseObserver();
      injectColumnHeader();
      injectAllCells();
      resumeObserver();
      loadPositions(reviewIds);
    }, OBSERVER_DEBOUNCE_MS);
  }

  observer = new MutationObserver(handleMutation);

  // --- Initial injection ---

  injectColumnHeader();
  injectAllCells();
  resumeObserver();

  var initialReviewIds = extractReviewIds();
  if (initialReviewIds.length > 0) {
    loadPositions(initialReviewIds);
  }
})();
