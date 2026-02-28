require('jest-webextension-mock');

// localStorage mock with jest.fn() wrappers for assertions.
// jsdom provides localStorage but we need spyable functions.
var store = {};

var localStorageMock = {
  getItem: jest.fn(function (key) {
    return key in store ? store[key] : null;
  }),
  setItem: jest.fn(function (key, value) {
    store[key] = String(value);
  }),
  removeItem: jest.fn(function (key) {
    delete store[key];
  }),
  clear: jest.fn(function () {
    store = {};
  }),
};

Object.defineProperty(global, 'localStorage', { value: localStorageMock });

/** Reset localStorage store and clear all mock call history. */
global.resetLocalStorage = function () {
  store = {};
  localStorageMock.getItem.mockClear();
  localStorageMock.setItem.mockClear();
  localStorageMock.removeItem.mockClear();
  localStorageMock.clear.mockClear();
};
