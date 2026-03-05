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
    th.className = POSITION_COL_CLASS + " gr-shelf-pos-header";
    th.textContent = "Position";
    headerRow.appendChild(th);
  }

  function injectCellForRow(row) {
    // Don't double-inject
    if (row.querySelector("." + POSITION_COL_CLASS)) return null;

    var td = document.createElement("td");
    td.className = POSITION_COL_CLASS + " gr-shelf-pos-cell";

    // Loading state
    var spinner = document.createElement("span");
    spinner.className = "gr-shelf-pos-spinner";
    td.appendChild(spinner);

    row.appendChild(td);
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

    var saveBtn = document.createElement("button");
    saveBtn.className = "gr-shelf-pos-save";
    saveBtn.textContent = "Save";
    saveBtn.disabled = true;

    input.addEventListener("input", function () {
      var val = input.value.trim();
      var invalid = val !== "" && (!/^\d+$/.test(val) || parseInt(val, 10) < 1);
      var changed = val !== input.dataset.originalValue;
      saveBtn.disabled = !changed || invalid;
      input.classList.toggle("gr-shelf-pos-changed", changed && !invalid);
      input.classList.toggle("gr-shelf-pos-error", invalid);
      if (!invalid) input.classList.remove("gr-shelf-pos-saved");
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!saveBtn.disabled) handleSave(input, saveBtn);
      }
    });

    saveBtn.addEventListener("click", function () {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      handleSave(input, saveBtn);
    });

    cell.appendChild(input);
    cell.appendChild(saveBtn);
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

        if (results.has(rid)) {
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

  async function handleSave(input, saveBtn) {
    var val = input.value.trim();
    if (val !== "" && (!/^\d+$/.test(val) || parseInt(val, 10) < 1)) {
      input.classList.add("gr-shelf-pos-error");
      return;
    }

    var shelfId = input.dataset.shelfId;
    saveBtn.disabled = true;
    saveBtn.textContent = "\u2026";

    try {
      var result = await saveBatchPosition(userId, shelfId, val, authToken);

      if (result.confirmedPosition) {
        input.value = result.confirmedPosition;
        input.dataset.originalValue = result.confirmedPosition;
      } else {
        input.dataset.originalValue = val;
      }

      // Clear cache — other books' positions shifted
      clearCache(userId);

      input.classList.remove("gr-shelf-pos-changed");
      input.classList.add("gr-shelf-pos-saved");
      LOG("Shelf: position saved for shelf", shelfId, ":", input.value);

      setTimeout(function () { input.classList.remove("gr-shelf-pos-saved"); }, SAVE_FLASH_MS);

      // Re-fetch positions for all visible rows
      refreshAllPositions();
    } catch (err) {
      LOG("Shelf: save failed:", err);
      input.classList.add("gr-shelf-pos-error");
    } finally {
      saveBtn.textContent = "Save";
      saveBtn.disabled = input.value === input.dataset.originalValue;
    }
  }

  async function refreshAllPositions() {
    var reviewIds = extractReviewIds();
    if (reviewIds.length === 0) return;

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

        if (results.has(rid)) {
          var data = results.get(rid);
          var input = cell.querySelector(".gr-shelf-pos-input");
          if (input) {
            input.value = data.position;
            input.dataset.originalValue = data.position;
            input.dataset.shelfId = data.shelfId;
            input.classList.remove("gr-shelf-pos-changed", "gr-shelf-pos-error");
            var saveBtn = cell.querySelector(".gr-shelf-pos-save");
            if (saveBtn) saveBtn.disabled = true;
          }
        }
      });
      resumeObserver();
    } catch (err) {
      LOG("Shelf: refresh failed:", err);
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
