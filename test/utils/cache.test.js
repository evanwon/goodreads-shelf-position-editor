var {
  DEFAULT_TTL_HOURS,
  USER_ID_CACHE_KEY,
  cacheKey,
  clearCache,
  loadCache,
  saveCache,
} = require('../../src/utils/cache.js');

beforeEach(function () {
  global.resetLocalStorage();
});

describe('constants', function () {
  test('DEFAULT_TTL_HOURS is 168 (1 week)', function () {
    expect(DEFAULT_TTL_HOURS).toBe(168);
  });

  test('USER_ID_CACHE_KEY is correct', function () {
    expect(USER_ID_CACHE_KEY).toBe('gr-book-pos-userid');
  });
});

describe('cacheKey', function () {
  test('returns prefixed key for user ID', function () {
    expect(cacheKey('12345')).toBe('gr-pos-fixer-12345');
  });
});

describe('clearCache', function () {
  test('removes both data and timestamp keys', function () {
    localStorage.setItem('gr-pos-fixer-123', '{}');
    localStorage.setItem('gr-pos-fixer-123-ts', '999');
    clearCache('123');
    expect(localStorage.removeItem).toHaveBeenCalledWith('gr-pos-fixer-123');
    expect(localStorage.removeItem).toHaveBeenCalledWith('gr-pos-fixer-123-ts');
  });
});

describe('loadCache', function () {
  test('returns empty Map when nothing in storage', function () {
    var result = loadCache('123', 60000);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test('returns Map with cached data when TTL valid', function () {
    var data = { rev1: { shelfId: 's1', position: 5 } };
    localStorage.setItem('gr-pos-fixer-123', JSON.stringify(data));
    localStorage.setItem('gr-pos-fixer-123-ts', String(Date.now()));

    var result = loadCache('123', 60000);
    expect(result).toBeInstanceOf(Map);
    expect(result.get('rev1')).toEqual({ shelfId: 's1', position: 5 });
  });

  test('returns empty Map and clears when TTL expired', function () {
    var data = { rev1: { shelfId: 's1', position: 5 } };
    localStorage.setItem('gr-pos-fixer-123', JSON.stringify(data));
    // Timestamp far in the past
    localStorage.setItem('gr-pos-fixer-123-ts', '0');

    var result = loadCache('123', 1000);
    expect(result.size).toBe(0);
    expect(localStorage.removeItem).toHaveBeenCalledWith('gr-pos-fixer-123');
  });

  test('returns data regardless of age when TTL is 0 (disabled)', function () {
    var data = { rev1: { shelfId: 's1', position: 5 } };
    localStorage.setItem('gr-pos-fixer-123', JSON.stringify(data));
    localStorage.setItem('gr-pos-fixer-123-ts', '0');

    var result = loadCache('123', 0);
    expect(result.size).toBe(1);
    expect(result.get('rev1')).toEqual({ shelfId: 's1', position: 5 });
  });

  test('returns empty Map on corrupt JSON', function () {
    localStorage.setItem('gr-pos-fixer-123', 'not-json{{{');
    localStorage.setItem('gr-pos-fixer-123-ts', String(Date.now()));

    var result = loadCache('123', 60000);
    expect(result.size).toBe(0);
  });
});

describe('saveCache', function () {
  test('writes JSON data and timestamp to localStorage', function () {
    var cache = new Map([['rev1', { shelfId: 's1', position: 3 }]]);
    saveCache('123', cache);

    expect(localStorage.setItem).toHaveBeenCalledWith(
      'gr-pos-fixer-123',
      JSON.stringify({ rev1: { shelfId: 's1', position: 3 } })
    );
    expect(localStorage.setItem).toHaveBeenCalledWith(
      'gr-pos-fixer-123-ts',
      expect.any(String)
    );
  });

  test('round-trips with loadCache', function () {
    var cache = new Map([
      ['rev1', { shelfId: 's1', position: 3 }],
      ['rev2', { shelfId: 's2', position: 7 }],
    ]);
    saveCache('456', cache);

    var loaded = loadCache('456', 60000);
    expect(loaded.size).toBe(2);
    expect(loaded.get('rev1')).toEqual({ shelfId: 's1', position: 3 });
    expect(loaded.get('rev2')).toEqual({ shelfId: 's2', position: 7 });
  });
});
