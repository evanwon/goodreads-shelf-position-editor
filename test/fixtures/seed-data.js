// localStorage payloads per visual test scenario.
// Keys must match cache key conventions in src/content.js.
module.exports = {
  "book-on-shelf": {
    "gr-book-pos-userid": "12345678",
    "gr-pos-fixer-12345678": JSON.stringify({
      "1001": { shelfId: "5001", position: "42" }
    }),
    "gr-pos-fixer-12345678-ts": String(Date.now())
  },
  "book-not-on-shelf": {
    "gr-book-pos-userid": "12345678",
    "gr-pos-fixer-12345678": JSON.stringify({}),
    "gr-pos-fixer-12345678-ts": String(Date.now())
  },
  "book-error": {}
};
