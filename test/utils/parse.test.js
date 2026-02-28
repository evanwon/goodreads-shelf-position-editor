var {
  extractBookId,
  getBookTitle,
  cleanTitle,
  isValidPosition,
  formatRelativeTime,
  getUserIdFromPage,
  getCsrfFromPage,
} = require('../../src/utils/parse.js');

describe('extractBookId', function () {
  test('extracts ID from standard book URL', function () {
    expect(extractBookId('/book/show/12345')).toBe('12345');
  });

  test('extracts ID from slugged URL', function () {
    expect(extractBookId('/book/show/12345.The_Great_Gatsby')).toBe('12345');
  });

  test('returns null for non-book URL', function () {
    expect(extractBookId('/author/show/99')).toBeNull();
  });

  test('returns null for empty string', function () {
    expect(extractBookId('')).toBeNull();
  });

  test('extracts ID from URL with query params', function () {
    expect(extractBookId('/book/show/789?ref=nav')).toBe('789');
  });
});

describe('getBookTitle', function () {
  function makeDoc(html) {
    var parser = new DOMParser();
    return parser.parseFromString(html, 'text/html');
  }

  test('extracts title from og:title meta tag', function () {
    var doc = makeDoc('<meta property="og:title" content="The Hobbit">');
    expect(getBookTitle(doc)).toBe('The Hobbit');
  });

  test('trims whitespace from og:title', function () {
    var doc = makeDoc('<meta property="og:title" content="  Dune  ">');
    expect(getBookTitle(doc)).toBe('Dune');
  });

  test('strips trailing Unicode ellipsis', function () {
    var doc = makeDoc('<meta property="og:title" content="A Very Long Title\u2026">');
    expect(getBookTitle(doc)).toBe('A Very Long Title');
  });

  test('strips trailing ASCII ellipsis', function () {
    var doc = makeDoc('<meta property="og:title" content="A Very Long Title...">');
    expect(getBookTitle(doc)).toBe('A Very Long Title');
  });

  test('falls back to <title> tag with "by Author" pattern', function () {
    var doc = makeDoc('<title>The Hobbit by J.R.R. Tolkien | Goodreads</title>');
    expect(getBookTitle(doc)).toBe('The Hobbit');
  });

  test('returns null when no title found', function () {
    var doc = makeDoc('<html><body></body></html>');
    expect(getBookTitle(doc)).toBeNull();
  });

  test('returns null when og:title has empty content', function () {
    var doc = makeDoc('<meta property="og:title" content="">');
    expect(getBookTitle(doc)).toBeNull();
  });
});

describe('cleanTitle', function () {
  test('strips series info in parens', function () {
    expect(cleanTitle('The Hobbit (The Lord of the Rings, #0)')).toBe('The Hobbit');
  });

  test('strips series with multi-digit number', function () {
    expect(cleanTitle('Words of Radiance (The Stormlight Archive, #12)')).toBe('Words of Radiance');
  });

  test('leaves non-series parens alone', function () {
    expect(cleanTitle('Algorithms (4th Edition)')).toBe('Algorithms (4th Edition)');
  });

  test('returns already clean title unchanged', function () {
    expect(cleanTitle('Dune')).toBe('Dune');
  });
});

describe('isValidPosition', function () {
  test('accepts positive integer string', function () {
    expect(isValidPosition('5')).toBe(true);
  });

  test('accepts positive integer number', function () {
    expect(isValidPosition(1)).toBe(true);
  });

  test('rejects zero', function () {
    expect(isValidPosition('0')).toBe(false);
  });

  test('rejects negative number', function () {
    expect(isValidPosition('-1')).toBe(false);
  });

  test('rejects float string', function () {
    expect(isValidPosition('1.5')).toBe(false);
  });

  test('rejects empty string', function () {
    expect(isValidPosition('')).toBe(false);
  });

  test('rejects non-numeric string', function () {
    expect(isValidPosition('abc')).toBe(false);
  });
});

describe('formatRelativeTime', function () {
  var realNow;

  beforeEach(function () {
    realNow = Date.now;
    Date.now = jest.fn(function () { return 1000000; });
  });

  afterEach(function () {
    Date.now = realNow;
  });

  test('returns "just now" for < 60 seconds ago', function () {
    expect(formatRelativeTime(1000000 - 30 * 1000)).toBe('just now');
  });

  test('returns minutes ago', function () {
    expect(formatRelativeTime(1000000 - 5 * 60 * 1000)).toBe('5m ago');
  });

  test('returns hours ago', function () {
    expect(formatRelativeTime(1000000 - 3 * 60 * 60 * 1000)).toBe('3h ago');
  });

  test('returns days ago', function () {
    expect(formatRelativeTime(1000000 - 2 * 24 * 60 * 60 * 1000)).toBe('2d ago');
  });

  test('returns "just now" for timestamp equal to now', function () {
    expect(formatRelativeTime(1000000)).toBe('just now');
  });
});

describe('getUserIdFromPage', function () {
  function makeDoc(html) {
    var parser = new DOMParser();
    return parser.parseFromString(html, 'text/html');
  }

  test('extracts user ID from CurrentUserStore script', function () {
    var doc = makeDoc(
      '<script>CurrentUserStore.initializeWith({"profileUrl":"/user/show/12345-john"})</script>'
    );
    expect(getUserIdFromPage(doc)).toBe('12345');
  });

  test('returns null when no CurrentUserStore script', function () {
    var doc = makeDoc('<script>var x = 1;</script>');
    expect(getUserIdFromPage(doc)).toBeNull();
  });

  test('returns null when no scripts at all', function () {
    var doc = makeDoc('<html><body></body></html>');
    expect(getUserIdFromPage(doc)).toBeNull();
  });

  test('finds user ID among multiple scripts', function () {
    var doc = makeDoc(
      '<script>var x = 1;</script>' +
      '<script>CurrentUserStore.initializeWith({"profileUrl":"/user/show/99999-jane"})</script>' +
      '<script>var y = 2;</script>'
    );
    expect(getUserIdFromPage(doc)).toBe('99999');
  });
});

describe('getCsrfFromPage', function () {
  function makeDoc(html) {
    var parser = new DOMParser();
    return parser.parseFromString(html, 'text/html');
  }

  test('extracts CSRF token from meta tag', function () {
    var doc = makeDoc('<meta name="csrf-token" content="abc123token">');
    expect(getCsrfFromPage(doc)).toBe('abc123token');
  });

  test('returns null when meta tag missing', function () {
    var doc = makeDoc('<html><head></head></html>');
    expect(getCsrfFromPage(doc)).toBeNull();
  });
});
