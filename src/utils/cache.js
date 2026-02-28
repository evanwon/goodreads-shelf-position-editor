/**
 * Cache lifecycle functions extracted from content.js.
 * Loaded as a content script before content.js (shared scope),
 * and importable via require() in Jest.
 */

var DEFAULT_TTL_HOURS = 168;
var USER_ID_CACHE_KEY = "gr-book-pos-userid";

var _cacheLog = function () {
  var args = Array.prototype.slice.call(arguments);
  args.unshift("[GR Shelf Position]");
  console.log.apply(console, args);
};

/** Returns the localStorage key for a user's shelf cache. */
function cacheKey(userId) {
  return "gr-pos-fixer-" + userId;
}

/** Clears both the shelf cache and its timestamp for a user. */
function clearCache(userId) {
  localStorage.removeItem(cacheKey(userId));
  localStorage.removeItem(cacheKey(userId) + "-ts");
}

/**
 * Loads the shelf cache for a user, checking TTL expiry.
 * Returns a Map of reviewId -> { shelfId, position }.
 */
function loadCache(userId, cacheTtlMs) {
  try {
    var raw = localStorage.getItem(cacheKey(userId));
    if (!raw) return new Map();

    // Check TTL
    var ts = localStorage.getItem(cacheKey(userId) + "-ts");
    if (cacheTtlMs > 0 && (!ts || Date.now() - Number(ts) > cacheTtlMs)) {
      _cacheLog("Cache expired — clearing");
      clearCache(userId);
      return new Map();
    }

    return new Map(Object.entries(JSON.parse(raw)));
  } catch (e) {
    _cacheLog("Cache read failed:", e);
    return new Map();
  }
}

/** Saves the shelf cache and updates the timestamp. */
function saveCache(userId, cache) {
  try {
    localStorage.setItem(
      cacheKey(userId),
      JSON.stringify(Object.fromEntries(cache))
    );
    localStorage.setItem(cacheKey(userId) + "-ts", String(Date.now()));
  } catch (e) {
    _cacheLog("Cache write failed:", e);
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULT_TTL_HOURS: DEFAULT_TTL_HOURS,
    USER_ID_CACHE_KEY: USER_ID_CACHE_KEY,
    cacheKey: cacheKey,
    clearCache: clearCache,
    loadCache: loadCache,
    saveCache: saveCache,
  };
}
