/**
 * Shared shelf API functions extracted from content.js.
 * Loaded as a content script before content.js and shelf.js (shared scope),
 * and importable via require() in Jest.
 *
 * Dependencies (loaded before this file):
 *   - utils/parse.js: isValidPosition
 *   - utils/cache.js: loadCache, saveCache, cacheKey
 */

var SHELF_API_MAX_PAGES = 50;
var SHELF_API_ITEMS_PER_PAGE = 100;
var SHELF_API_PAGINATION_DELAY_MS = 200;

var _shelfApiLog = function () {
  var args = Array.prototype.slice.call(arguments);
  args.unshift("[GR Shelf Position]");
  console.log.apply(console, args);
};

/**
 * Parses shelf table rows from a document, extracting shelfId + position
 * from position inputs. Populates the cache Map in-place.
 *
 * @param {Document} doc - Parsed HTML document containing #booksBody rows
 * @param {Map} cache - Map of reviewId -> { shelfId, position } to populate
 * @param {string|null} targetReviewId - Optional review ID to log about
 * @returns {number} Number of rows found
 */
function parsePageRows(doc, cache, targetReviewId) {
  var rows = doc.querySelectorAll("#booksBody tr.bookalike.review");
  var cached = 0;
  rows.forEach(function (row) {
    var rowMatch = row.id.match(/^review_(\d+)$/);
    if (!rowMatch) return;
    var revId = rowMatch[1];
    var posInput = row.querySelector('input[name^="positions["]');
    if (!posInput) {
      if (revId === targetReviewId) _shelfApiLog("Target review", revId, "found but has no position input");
      return;
    }
    var nameMatch = posInput.name.match(/^positions\[(\d+)\]$/);
    if (!nameMatch) return;
    var posValue = posInput.value || "";
    if (posValue !== "" && !isValidPosition(posValue)) return;
    cache.set(revId, { shelfId: nameMatch[1], position: posValue });
    cached++;
  });
  if (cached < rows.length) _shelfApiLog("Parsed", rows.length, "rows,", cached, "cached,", rows.length - cached, "skipped");
  return rows.length;
}

/**
 * Finds shelf data (shelfId + position) for a single review ID.
 * Checks cache first, then paginates the shelf to find it.
 *
 * @param {string} userId - Goodreads user ID
 * @param {string} reviewId - Review ID to look up
 * @param {number} cacheTtlMs - Cache TTL in milliseconds
 * @param {function|null} onProgress - Optional callback(page, totalPages)
 * @returns {Promise<{shelfId: string, position: string, fromCache: boolean, cacheTimestamp: number|null}|null>}
 */
async function findShelfData(userId, reviewId, cacheTtlMs, onProgress) {
  // Check cache first
  var cache = loadCache(userId, cacheTtlMs);
  _shelfApiLog("Cache has", cache.size, "entries");

  if (cache.has(reviewId)) {
    _shelfApiLog("Phase 2 — cache hit for review", reviewId);
    var ts = localStorage.getItem(cacheKey(userId) + "-ts");
    return Object.assign({}, cache.get(reviewId), { fromCache: true, cacheTimestamp: ts ? Number(ts) : null });
  }

  _shelfApiLog("Phase 2 — paginating shelf for review", reviewId);

  var maxPages = SHELF_API_MAX_PAGES;
  var result = null;
  var totalPages = null;

  for (var page = 1; page <= maxPages; page++) {
    if (onProgress) onProgress(page, totalPages);
    var url =
      "https://www.goodreads.com/review/list/" + userId + "?shelf=to-read" +
      "&sort=date_added&order=d&per_page=" + SHELF_API_ITEMS_PER_PAGE + "&page=" + page + "&view=table";

    var resp = await fetch(url, { credentials: "same-origin" });
    if (!resp.ok) throw new Error("Shelf page " + page + " HTTP " + resp.status);

    var html = await resp.text();
    var doc = new DOMParser().parseFromString(html, "text/html");

    // Parse total book count from page 1 to enable percentage progress
    if (page === 1 && !totalPages) {
      var titleEl = doc.querySelector("title");
      var countMatch = titleEl && titleEl.textContent ? titleEl.textContent.match(/\(([\d,]+)\s+books?\)/) : null;
      if (countMatch) {
        var totalBooks = parseInt(countMatch[1].replace(/,/g, ""), 10);
        totalPages = Math.ceil(totalBooks / SHELF_API_ITEMS_PER_PAGE);
        _shelfApiLog("Total books:", totalBooks, "— estimated pages:", totalPages);
      }
    }

    var rowCount = parsePageRows(doc, cache, reviewId);
    if (rowCount === 0) break;

    if (cache.has(reviewId) && !result) {
      result = Object.assign({}, cache.get(reviewId), { fromCache: false });
      _shelfApiLog("Found on page", page);
      saveCache(userId, cache);
      return result;
    }

    _shelfApiLog("Page", page, "—", rowCount, "rows, not found yet");

    if (page < maxPages) {
      await new Promise(function (resolve) { setTimeout(resolve, SHELF_API_PAGINATION_DELAY_MS); });
    }
  }

  // Save whatever we cached even if book wasn't found
  saveCache(userId, cache);
  return result ? result : null;
}

/**
 * Batch version of findShelfData for multiple review IDs.
 * Checks cache for all IDs, then paginates once until all found or pages exhausted.
 *
 * @param {string} userId - Goodreads user ID
 * @param {string[]} reviewIds - Array of review IDs to look up
 * @param {number} cacheTtlMs - Cache TTL in milliseconds
 * @param {function|null} onProgress - Optional callback(page, totalPages)
 * @returns {Promise<Map<string, {shelfId: string, position: string, fromCache: boolean, cacheTimestamp: number|null}>>}
 */
async function findAllShelfData(userId, reviewIds, cacheTtlMs, onProgress) {
  var results = new Map();
  var cache = loadCache(userId, cacheTtlMs);
  var ts = localStorage.getItem(cacheKey(userId) + "-ts");
  var cacheTimestamp = ts ? Number(ts) : null;

  _shelfApiLog("Batch lookup for", reviewIds.length, "reviews, cache has", cache.size, "entries");

  // Check cache for all review IDs
  var missing = [];
  for (var i = 0; i < reviewIds.length; i++) {
    var rid = reviewIds[i];
    if (cache.has(rid)) {
      results.set(rid, Object.assign({}, cache.get(rid), { fromCache: true, cacheTimestamp: cacheTimestamp }));
    } else {
      missing.push(rid);
    }
  }

  _shelfApiLog("Cache hits:", results.size, "misses:", missing.length);

  if (missing.length === 0) return results;

  // Paginate to find missing entries
  var missingSet = new Set(missing);
  var maxPages = SHELF_API_MAX_PAGES;
  var totalPages = null;

  for (var page = 1; page <= maxPages; page++) {
    if (onProgress) onProgress(page, totalPages);
    var url =
      "https://www.goodreads.com/review/list/" + userId + "?shelf=to-read" +
      "&sort=date_added&order=d&per_page=" + SHELF_API_ITEMS_PER_PAGE + "&page=" + page + "&view=table";

    var resp = await fetch(url, { credentials: "same-origin" });
    if (!resp.ok) throw new Error("Shelf page " + page + " HTTP " + resp.status);

    var html = await resp.text();
    var doc = new DOMParser().parseFromString(html, "text/html");

    if (page === 1 && !totalPages) {
      var titleEl = doc.querySelector("title");
      var countMatch = titleEl && titleEl.textContent ? titleEl.textContent.match(/\(([\d,]+)\s+books?\)/) : null;
      if (countMatch) {
        var totalBooks = parseInt(countMatch[1].replace(/,/g, ""), 10);
        totalPages = Math.ceil(totalBooks / SHELF_API_ITEMS_PER_PAGE);
        _shelfApiLog("Total books:", totalBooks, "— estimated pages:", totalPages);
      }
    }

    var rowCount = parsePageRows(doc, cache, null);
    if (rowCount === 0) break;

    // Check if any missing IDs were found on this page
    var foundOnPage = [];
    missingSet.forEach(function (rid) {
      if (cache.has(rid)) {
        results.set(rid, Object.assign({}, cache.get(rid), { fromCache: false }));
        foundOnPage.push(rid);
      }
    });
    foundOnPage.forEach(function (rid) { missingSet.delete(rid); });

    if (foundOnPage.length > 0) {
      _shelfApiLog("Page", page, "— found", foundOnPage.length, "reviews,", missingSet.size, "still missing");
    }

    if (missingSet.size === 0) {
      _shelfApiLog("All reviews found by page", page);
      saveCache(userId, cache);
      return results;
    }

    _shelfApiLog("Page", page, "—", rowCount, "rows,", missingSet.size, "still missing");

    if (page < maxPages) {
      await new Promise(function (resolve) { setTimeout(resolve, SHELF_API_PAGINATION_DELAY_MS); });
    }
  }

  saveCache(userId, cache);
  return results;
}

/**
 * Saves a batch position update via POST to Goodreads.
 *
 * @param {string} userId - Goodreads user ID
 * @param {string} shelfId - Shelf ID for the position
 * @param {string} position - New position value
 * @param {string} authToken - CSRF token
 * @returns {Promise<{success: boolean, confirmedPosition: string|null}>}
 */
async function saveBatchPosition(userId, shelfId, position, authToken) {
  var params = new URLSearchParams();
  if (position !== "") {
    params.append("positions[" + shelfId + "]", position);
  }
  params.append("view", "table");
  params.append("authenticity_token", authToken);

  var resp = await fetch(
    "https://www.goodreads.com/shelf/move_batch/" + userId,
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

  if (!resp.ok) throw new Error("HTTP " + resp.status);

  var text = await resp.text();
  var data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    _shelfApiLog("Response is not JSON (length:", text.length + "), treating as success");
  }

  var confirmedPosition = null;
  if (data && data.shelves) {
    var shelf = data.shelves.find(function (s) { return String(s.id) === shelfId; });
    if (shelf && isValidPosition(shelf.position)) {
      confirmedPosition = String(shelf.position);
    }
  }

  return { success: true, confirmedPosition: confirmedPosition };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SHELF_API_MAX_PAGES: SHELF_API_MAX_PAGES,
    SHELF_API_ITEMS_PER_PAGE: SHELF_API_ITEMS_PER_PAGE,
    SHELF_API_PAGINATION_DELAY_MS: SHELF_API_PAGINATION_DELAY_MS,
    parsePageRows: parsePageRows,
    findShelfData: findShelfData,
    findAllShelfData: findAllShelfData,
    saveBatchPosition: saveBatchPosition,
  };
}
