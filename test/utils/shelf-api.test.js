var {
  SHELF_API_MAX_PAGES,
  SHELF_API_ITEMS_PER_PAGE,
  SHELF_API_PAGINATION_DELAY_MS,
  parsePageRows,
  findShelfData,
  findAllShelfData,
  saveBatchPosition,
} = require('../../src/utils/shelf-api.js');

// shelf-api.js depends on functions from parse.js and cache.js in content script scope.
// In Jest they're loaded via require, so we need to make them global.
var parseExports = require('../../src/utils/parse.js');
var cacheExports = require('../../src/utils/cache.js');
Object.assign(global, parseExports, cacheExports);

beforeEach(function () {
  global.resetLocalStorage();
  jest.restoreAllMocks();
});

describe('constants', function () {
  test('MAX_SHELF_PAGES is 50', function () {
    expect(SHELF_API_MAX_PAGES).toBe(50);
  });

  test('ITEMS_PER_PAGE is 100', function () {
    expect(SHELF_API_ITEMS_PER_PAGE).toBe(100);
  });

  test('PAGINATION_DELAY_MS is 200', function () {
    expect(SHELF_API_PAGINATION_DELAY_MS).toBe(200);
  });
});

describe('parsePageRows', function () {
  function makeDoc(html) {
    var parser = new DOMParser();
    return parser.parseFromString(
      '<html><body><table><tbody id="booksBody">' + html + '</tbody></table></body></html>',
      'text/html'
    );
  }

  test('populates cache from rows with position inputs', function () {
    var doc = makeDoc(
      '<tr id="review_100" class="bookalike review">' +
      '  <td><input name="positions[500]" value="3"></td>' +
      '</tr>' +
      '<tr id="review_200" class="bookalike review">' +
      '  <td><input name="positions[600]" value="7"></td>' +
      '</tr>'
    );
    var cache = new Map();
    var count = parsePageRows(doc, cache, null);

    expect(count).toBe(2);
    expect(cache.size).toBe(2);
    expect(cache.get('100')).toEqual({ shelfId: '500', position: '3' });
    expect(cache.get('200')).toEqual({ shelfId: '600', position: '7' });
  });

  test('skips rows without position inputs', function () {
    var doc = makeDoc(
      '<tr id="review_100" class="bookalike review">' +
      '  <td>No input here</td>' +
      '</tr>'
    );
    var cache = new Map();
    var count = parsePageRows(doc, cache, null);

    expect(count).toBe(1);
    expect(cache.size).toBe(0);
  });

  test('skips rows with invalid position values', function () {
    var doc = makeDoc(
      '<tr id="review_100" class="bookalike review">' +
      '  <td><input name="positions[500]" value="abc"></td>' +
      '</tr>'
    );
    var cache = new Map();
    var count = parsePageRows(doc, cache, null);

    expect(count).toBe(1);
    expect(cache.size).toBe(0);
  });

  test('accepts empty position values', function () {
    var doc = makeDoc(
      '<tr id="review_100" class="bookalike review">' +
      '  <td><input name="positions[500]" value=""></td>' +
      '</tr>'
    );
    var cache = new Map();
    var count = parsePageRows(doc, cache, null);

    expect(count).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.get('100')).toEqual({ shelfId: '500', position: '' });
  });

  test('returns 0 for empty table body', function () {
    var doc = makeDoc('');
    var cache = new Map();
    var count = parsePageRows(doc, cache, null);

    expect(count).toBe(0);
    expect(cache.size).toBe(0);
  });
});

describe('findShelfData', function () {
  test('returns cached data when available', async function () {
    var cache = new Map([['rev1', { shelfId: 's1', position: '5' }]]);
    saveCache('123', cache);

    var result = await findShelfData('123', 'rev1', 60000, null);

    expect(result).not.toBeNull();
    expect(result.shelfId).toBe('s1');
    expect(result.position).toBe('5');
    expect(result.fromCache).toBe(true);
    expect(result.cacheTimestamp).toEqual(expect.any(Number));
  });

  test('returns null and saves empty cache when fetch returns empty page', async function () {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(
        '<html><title>shelf (0 books)</title><body><table><tbody id="booksBody"></tbody></table></body></html>'
      ),
    });

    var result = await findShelfData('123', 'rev1', 60000, null);

    expect(result).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('findAllShelfData', function () {
  test('returns all cached data when all IDs present', async function () {
    var cache = new Map([
      ['rev1', { shelfId: 's1', position: '5' }],
      ['rev2', { shelfId: 's2', position: '10' }],
    ]);
    saveCache('123', cache);

    var results = await findAllShelfData('123', ['rev1', 'rev2'], 60000, null);

    expect(results.size).toBe(2);
    expect(results.get('rev1').fromCache).toBe(true);
    expect(results.get('rev2').fromCache).toBe(true);
  });

  test('returns empty map when no IDs match and page is empty', async function () {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(
        '<html><title>shelf (0 books)</title><body><table><tbody id="booksBody"></tbody></table></body></html>'
      ),
    });

    var results = await findAllShelfData('123', ['rev1'], 60000, null);

    expect(results.size).toBe(0);
  });

  test('calls onProgress callback during pagination', async function () {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(
        '<html><title>shelf (0 books)</title><body><table><tbody id="booksBody"></tbody></table></body></html>'
      ),
    });

    var onProgress = jest.fn();
    await findAllShelfData('123', ['rev1'], 60000, onProgress);

    expect(onProgress).toHaveBeenCalled();
  });
});

describe('saveBatchPosition', function () {
  test('sends correct POST request', async function () {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue('{}'),
    });

    var result = await saveBatchPosition('123', 's1', '5', 'csrf-token');

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://www.goodreads.com/shelf/move_batch/123',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
      })
    );

    var callArgs = global.fetch.mock.calls[0];
    var body = callArgs[1].body;
    expect(body).toContain('positions%5Bs1%5D=5');
    expect(body).toContain('authenticity_token=csrf-token');
  });

  test('returns confirmedPosition from JSON response', async function () {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify({
        shelves: [{ id: 's1', position: 3 }],
      })),
    });

    var result = await saveBatchPosition('123', 's1', '3', 'csrf-token');

    expect(result.success).toBe(true);
    expect(result.confirmedPosition).toBe('3');
  });

  test('returns null confirmedPosition for non-JSON response', async function () {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue('<html>OK</html>'),
    });

    var result = await saveBatchPosition('123', 's1', '5', 'csrf-token');

    expect(result.success).toBe(true);
    expect(result.confirmedPosition).toBeNull();
  });

  test('throws on HTTP error', async function () {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(saveBatchPosition('123', 's1', '5', 'csrf-token')).rejects.toThrow('HTTP 500');
  });

  test('sends empty position correctly', async function () {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue('{}'),
    });

    await saveBatchPosition('123', 's1', '', 'csrf-token');

    var callArgs = global.fetch.mock.calls[0];
    var body = callArgs[1].body;
    expect(body).not.toContain('positions');
    expect(body).toContain('view=table');
  });
});
