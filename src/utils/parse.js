/**
 * Pure parsing and validation functions extracted from content.js.
 * Loaded as a content script before content.js (shared scope),
 * and importable via require() in Jest.
 */

/** Extracts the numeric book ID from a Goodreads book page pathname. */
function extractBookId(pathname) {
  var match = pathname.match(/\/book\/show\/(\d+)/);
  return match ? match[1] : null;
}

/** Extracts the book title from a document's og:title or <title> tag. */
function getBookTitle(doc) {
  var title = null;

  // Primary: og:title meta tag (stable across layouts)
  var ogTitle = doc.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    var content = ogTitle.getAttribute("content");
    if (content) title = content.trim();
  }

  // Fallback: page <title> — "Book Title by Author Name | Goodreads"
  if (!title && doc.title) {
    var titleMatch = doc.title.match(/^(.+?)\s+by\s+/);
    if (titleMatch) title = titleMatch[1].trim();
  }

  if (!title) return null;

  // Strip trailing ellipsis — og:title often truncates long titles
  title = title.replace(/\u2026$/, "").replace(/\.\.\.$/, "").trim();

  return title;
}

/** Strips series info in parens, e.g. "The Hobbit (The Lord of the Rings, #0)". */
function cleanTitle(title) {
  return title.replace(/\s*\([^)]*#\d+[^)]*\)\s*$/, "").trim();
}

/** Returns true if value is a positive integer (string or number). */
function isValidPosition(value) {
  return /^\d+$/.test(String(value)) && parseInt(value, 10) >= 1;
}

/** Formats a timestamp as a relative time string (e.g. "2h ago"). */
function formatRelativeTime(timestampMs) {
  var diffSec = Math.floor((Date.now() - timestampMs) / 1000);
  if (diffSec < 60) return "just now";
  var diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return diffMin + "m ago";
  var diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return diffHr + "h ago";
  return Math.floor(diffHr / 24) + "d ago";
}

/** Extracts user ID from inline scripts containing CurrentUserStore. */
function getUserIdFromPage(doc) {
  var scripts = doc.querySelectorAll("script");
  for (var i = 0; i < scripts.length; i++) {
    var text = scripts[i].textContent;
    var match = text.match(
      /CurrentUserStore\.initializeWith\(\s*\{[^}]*"profileUrl"\s*:\s*"\/user\/show\/(\d+)/
    );
    if (match) return match[1];
  }
  return null;
}

/** Extracts the CSRF token from a document's meta tag. */
function getCsrfFromPage(doc) {
  var meta = doc.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute("content") : null;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    extractBookId: extractBookId,
    getBookTitle: getBookTitle,
    cleanTitle: cleanTitle,
    isValidPosition: isValidPosition,
    formatRelativeTime: formatRelativeTime,
    getUserIdFromPage: getUserIdFromPage,
    getCsrfFromPage: getCsrfFromPage,
  };
}
