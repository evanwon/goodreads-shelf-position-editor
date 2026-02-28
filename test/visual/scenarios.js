module.exports = [
  {
    name: "book-on-shelf",
    path: "/book/show/12345",
    seedKey: "book-on-shelf",
    waitFor: ".gr-book-pos-input",
    description: "Happy path: book on shelf with position editor"
  },
  {
    name: "book-not-on-shelf",
    path: "/book/show/99999",
    seedKey: "book-not-on-shelf",
    waitFor: ".gr-book-pos-empty",
    description: "Book not found on To Read shelf"
  },
  {
    name: "error-state",
    path: "/book/show/00000",
    seedKey: "book-error",
    waitFor: ".gr-book-pos-error-msg",
    description: "Error state when auth data is missing"
  }
];
