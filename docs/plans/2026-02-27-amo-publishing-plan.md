# GR Shelf Position Editor — AMO Publishing & CI/CD Plan

## Context

The GR Shelf Position Editor is a Firefox content-script-only extension (835 lines, no background page, no dependencies) that's functionally complete but has zero build tooling, tests, or CI/CD. The goal is to:

1. Publish to the Firefox Add-ons Marketplace (AMO)
2. Automate the build/deploy pipeline, replicating the robust patterns from [fancy-links](https://github.com/evanwon/fancy-links/)
3. Migrate to Manifest V3 for future Chrome Web Store compatibility
4. Add automated tests for core logic

This is a multi-session effort. Each phase below is independently committable.

---

## Phase 1: Project Restructuring — [x] Done

**Goal**: Move source files into `src/`, establish package.json and dev tooling.

### File moves (root → src/)
- `manifest.json` → `src/manifest.json`
- `content.js` → `src/content.js`
- `content.css` → `src/content.css`
- `options.html` → `src/options.html`
- `options.js` → `src/options.js`
- `icons/icon-48.svg` → `src/icons/icon-48.svg`

### Files staying in root
README.md, CLAUDE.md, PRIVACY.md, LICENSE, TODO.md, .gitignore

### New root files

**`package.json`** — Replicating fancy-links scripts:
```json
{
  "name": "gr-shelf-position-editor",
  "version": "2.0.0",
  "private": true,
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "test:ci": "jest --ci --coverage --maxWorkers=2",
    "build": "web-ext build --source-dir=src --artifacts-dir=dist --overwrite-dest",
    "build:firefox": "npm run lint:firefox && npm run build",
    "lint:firefox": "web-ext lint --source-dir=src",
    "test:build": "npm test && npm run lint:firefox && npm run build",
    "dev": "web-ext run --source-dir=src"
  },
  "devDependencies": {
    "@types/firefox-webext-browser": "^120.0.4",
    "jest": "^29.7.0",
    "jest-environment-jsdom": "^29.7.0",
    "jest-webextension-mock": "^3.9.0",
    "jsdom": "^26.1.0"
  }
}
```

**`.npmrc`** — Security-first config (from fancy-links):
```
ignore-scripts=true
audit-level=moderate
fund=false
package-lock=true
```

**`.gitattributes`** — Consistent line endings (from fancy-links)

**`jsconfig.json`** — VSCode IntelliSense for browser APIs

**`.vscode/launch.json`** + **`.vscode/extensions.json`** — Firefox debugger config (adapted from fancy-links)

### Update `.gitignore`
Add: `dist/`, `web-ext-artifacts/`, `*.xpi`, `*.zip`, `node_modules/`, `coverage/`, `.nyc_output/`, `npm-debug.log*`, `.DS_Store`, `Thumbs.db`

### Target structure after Phase 1
```
gr-shelf-position-editor/
  src/
    manifest.json
    content.js
    content.css
    options.html
    options.js
    icons/icon-48.svg
  .vscode/launch.json, extensions.json
  package.json, package-lock.json
  jest.config.js
  jsconfig.json
  .npmrc, .gitattributes, .gitignore
  CLAUDE.md, README.md, PRIVACY.md, LICENSE, TODO.md
```

### Verification
- `npm ci --ignore-scripts` installs cleanly
- `npx web-ext lint --source-dir=src` passes
- `npx web-ext build --source-dir=src --artifacts-dir=dist` produces a zip
- Loading via `about:debugging` still works

---

## Phase 2: Manifest V3 Migration — [x] Done

**Goal**: Upgrade from MV2 to MV3. This is a lightweight migration for content-script-only extensions.

### Changes to `src/manifest.json`

1. `"manifest_version": 2` → `"manifest_version": 3`
2. Add `"version_name": "2.0.0"` (for pre-release support, matching fancy-links)
3. Bump `"version": "1.0"` → `"version": "2.0.0"` (major version for MV3 restructuring)
4. Extract host permissions:
   ```
   "permissions": ["storage"],
   "host_permissions": [
     "*://www.goodreads.com/",
     "*://www.goodreads.com/review/list/*",
     "*://www.goodreads.com/shelf/move_batch/*"
   ]
   ```
5. Remove `"browser_style": true` from `options_ui` (deprecated in MV3; options.html already has full inline styles)
6. Keep `browser_specific_settings.gecko` with existing `data_collection_permissions`
7. Keep `strict_min_version: "109.0"` (Firefox 109 = first MV3 support)

### No code changes needed
- Content scripts work identically in MV3
- `browser.storage.local` works identically in MV3
- `fetch()` with `credentials: "same-origin"` in content scripts is unchanged

### Verification
- `npx web-ext lint --source-dir=src` passes with MV3
- Load via `about:debugging` → navigate to a Goodreads book page → widget works

---

## Phase 3: Icon Generation — [ ]

**Goal**: Create multi-size PNG icons for AMO listing (requires 48px+, recommends 96px for high-DPI).

### Required sizes
- `src/icons/icon-16.png`
- `src/icons/icon-32.png`
- `src/icons/icon-48.png`
- `src/icons/icon-96.png`
- `src/icons/icon-128.png`

Keep `src/icons/icon-48.svg` as the source of truth.

### Generation approach
Use a `tools/generate-icons.js` script (one-off, not a build dependency). Could use sharp, Inkscape CLI, or ImageMagick. Alternatively, render manually from the SVG.

### Update manifest.json icons
```json
"icons": {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "96": "icons/icon-96.png",
  "128": "icons/icon-128.png"
}
```

### Verification
- Icons display correctly in `about:debugging` and `about:addons`

---

## Phase 4: Extract Utility Modules for Testability — [ ]

**Goal**: Extract pure functions from the 835-line content.js IIFE into separate files that Jest can import, using the same multi-file content script pattern fancy-links uses.

### Key insight: no duplication needed
The manifest's `content_scripts.js` array loads multiple files into the same scope. We list utility files before content.js:
```json
"content_scripts": [{
  "js": ["utils/parse.js", "utils/cache.js", "content.js"],
  "css": ["content.css"],
  ...
}]
```

Each utility file defines functions at the top level (available to content.js at runtime) and exports via CommonJS for Jest:
```javascript
function extractBookId(pathname) { ... }
// ... more functions ...
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractBookId, ... };
}
```

This is exactly the pattern fancy-links uses for its background scripts (`utils/clean-url.js` loaded before `background/background.js`).

### `src/utils/parse.js` — Pure parsing/validation functions
Extract from content.js:
- `extractBookId(pathname)` — from Step 1 (line ~45)
- `getBookTitle(doc)` — from Step 2 (line ~52-74)
- `cleanTitle(title)` — from Step 5 (line ~194-197)
- `isValidPosition(value)` — (line ~25-27)
- `formatRelativeTime(timestampMs)` — (line ~30-38)
- `getUserIdFromPage(doc)` — from Step 3 (line ~80-90)
- `getCsrfFromPage(doc)` — (line ~92-95)

### `src/utils/cache.js` — Cache lifecycle functions
Extract from content.js:
- `cacheKey(userId)` — (line ~154-156)
- `loadCache(userId, cacheTtlMs)` — (line ~158-177), parameterize cacheTtlMs instead of relying on closure
- `saveCache(userId, cache)` — (line ~179-186)
- `clearCache(userId)` — new helper consolidating the removeItem calls

Constants: `DEFAULT_TTL_HOURS`, `USER_ID_CACHE_KEY`

### Update `content.js`
- Remove extracted function definitions (they're now loaded from utils/ files before content.js)
- Keep: DOM manipulation, fetch/network functions, `run()` orchestrator, MutationObserver
- The IIFE still wraps the non-utility code to avoid polluting global scope
- References to extracted functions (e.g., `extractBookId`, `loadCache`) just work because they're defined in the shared content script scope

### Verification
- `node -e "const p = require('./src/utils/parse.js'); console.log(p.extractBookId('/book/show/123'))"` → `123`
- Load via `about:debugging` → widget still works (functions available in content script scope)

---

## Phase 5: Testing Setup — [ ]

**Goal**: Add Jest test suite with the same infrastructure as fancy-links.

### `jest.config.js`
```javascript
module.exports = {
  testEnvironment: 'jsdom',
  setupFilesAfterSetup: ['<rootDir>/test/setup.js'],
  testMatch: ['**/test/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/icons/**'],
  coverageThreshold: {
    global: { branches: 60, functions: 50, lines: 60, statements: 60 }
  }
};
```

### `test/setup.js`
- `require('jest-webextension-mock')` for browser.* APIs
- Mock `localStorage` with jest.fn() implementations
- `global.resetLocalStorage` helper for cleanup between tests

### Test files
- `test/utils/parse.test.js` — Test all parse.js functions:
  - extractBookId: standard URLs, slugged URLs, non-book URLs, empty
  - getBookTitle: og:title, title fallback, ellipsis stripping, null cases
  - cleanTitle: series info stripping
  - isValidPosition: positive ints, zero, negative, strings, floats
  - formatRelativeTime: just now, minutes, hours, days
  - getUserIdFromPage: script with CurrentUserStore, missing, multiple scripts
  - getCsrfFromPage: meta tag present, missing

- `test/utils/cache.test.js` — Test all cache.js functions:
  - loadCache: empty, valid data, expired TTL, TTL=0 (disabled), corrupt JSON
  - saveCache: writes JSON + timestamp
  - clearCache: removes both keys
  - cacheKey: format verification

### Verification
- `npm test` passes
- `npm run test:coverage` meets thresholds (60/50/60/60)

---

## Phase 6: CI/CD Pipeline — [ ]

**Goal**: GitHub Actions workflows replicating fancy-links, adapted for this project.

### `.github/workflows/test-pr.yml`
Triggers: PRs to `main` touching `src/**`, `test/**`, `package*.json`, `jest.config.js`

Steps: checkout → Node 22 → npm ci → security audit → web-ext lint → test:ci → upload coverage to Codecov

### `.github/workflows/build-release.yml`
Triggers: push tags `v*` OR manual `workflow_dispatch`

Manual inputs (same as fancy-links): `create_release`, `submit_to_amo`, `channel`, `version_notes`

Steps (adapted from fancy-links build-release.yml):
1. Checkout with 50-commit history + fetch tags
2. Setup Node 22, `npm ci --ignore-scripts`
3. Security audit
4. Run `test:ci`
5. Install `web-ext` globally
6. Validate manifest (check `manifest_version === 3`)
7. Extract version from tag or manifest, extract `version_name`
8. Detect pre-release from `version_name` suffix (rc/beta/alpha/pre)
9. `web-ext lint --source-dir=src --warnings-as-errors`
10. `web-ext build --source-dir=src --artifacts-dir=dist`
11. Determine AMO submission (pre-release → unlisted; stable + AMO_SUBMISSION_ENABLED → listed)
12. Submit to AMO listed channel (with source code archive) OR sign unlisted
13. Generate changelog from git log since last stable tag
14. Create GitHub release with context-appropriate notes (AMO/signed/unsigned, pre-release warning)
15. Upload artifacts for manual builds (30-day retention)

### Substitutions from fancy-links
| fancy-links | gr-shelf-position-editor |
|---|---|
| `fancy-links` in artifact names | `gr-shelf-position-editor` |
| `manifest_version !== 2` | `manifest_version !== 3` |
| `Fancy Links v$VERSION` | `GR Shelf Position Editor v$VERSION` |
| Permissions: clipboardWrite, activeTab, storage, notifications | Permissions: storage + host permissions for goodreads.com |
| Firefox 109+ | Firefox 109+ |

### Pre-release versioning system (matching fancy-links)
For a pre-release of version 2.1.0:
- `version`: `"2.0.9.1"` (previous stable + `.9.N`)
- `version_name`: `"2.1.0-rc1"`
- Workflow detects `-rc` suffix → signs unlisted, creates GitHub pre-release

### Required GitHub configuration
**Secrets**: `AMO_API_KEY`, `AMO_API_SECRET` (from addons.mozilla.org developer account)
**Variables**: `AMO_SUBMISSION_ENABLED` (set to `true` to enable auto-submission on tag push)

### Verification
- Push a tag `v2.0.0-rc1` → workflow runs, builds, signs unlisted, creates pre-release
- Manual dispatch with `create_release=true` → workflow runs, creates release
- PR to main with src/ changes → test-pr workflow runs lint + tests

---

## Phase 7: Documentation Updates — [ ]

**Goal**: Update all docs to reflect new structure and workflows.

### CLAUDE.md
- Update project structure diagram to show `src/`, `test/`, `.github/`
- Add Essential Commands section: `npm test`, `npm run dev`, `npm run build:firefox`, `npm run lint:firefox`
- Add Version Management section with pre-release instructions
- Update Technical Details to reference MV3

### README.md
- Add AMO listing link (once published)
- Add "Development Setup" section: `npm ci`, `npm test`, `npm run dev`
- Add "Release Process" section: tag-based workflow, pre-release versioning
- Keep `about:debugging` instructions in a "Development" section

### TODO.md
- Mark completed items, add any new items discovered during implementation

### Verification
- All docs accurate and consistent with actual project state

---

## Phase 8: First AMO Submission — [ ]

**Goal**: Submit to addons.mozilla.org for the first time.

### Prerequisites
1. Create AMO developer account at https://addons.mozilla.org/developers/
2. Generate API credentials (API key + secret)
3. Set GitHub secrets: `AMO_API_KEY`, `AMO_API_SECRET`
4. Set GitHub variable: `AMO_SUBMISSION_ENABLED=true`

### AMO listing materials
- **Name**: GR Shelf Position Editor
- **Summary**: View and edit your To Read shelf position directly on Goodreads book pages
- **Category**: Productivity / Tools
- **Screenshots**: 2-3 showing the widget on Goodreads book pages (loading state, position display, save confirmation)
- **Privacy policy**: Link to PRIVACY.md in repo (already comprehensive)
- **Homepage**: GitHub repo URL

### Submission process
1. Tag `v2.0.0` and push → CI/CD builds, submits to AMO listed channel
2. AMO review (manual, may take days/weeks for first submission)
3. Once approved, extension appears in AMO store

### First-submission tips
- Include source code archive (workflow handles this via `git archive`)
- PRIVACY.md and README.md provide reviewer context
- The `data_collection_permissions` field in manifest is already set correctly
- No obfuscated code, no external dependencies — review should be straightforward

---

## Execution Notes

- **Each phase is independently committable** — you can do one phase per session
- **Phase order matters**: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 (each depends on prior phases)
- **Phases 2 and 3 can be done in parallel** (both modify manifest.json but different sections)
- **Phase 8 requires human action** (AMO account setup, screenshots)
- **Total scope**: ~8 files to create, ~6 files to modify, 2 workflow files to adapt from fancy-links

## Key Reference Files
- `c:\Users\evanw\src\fancy-links\.github\workflows\build-release.yml` — Main workflow template (475 lines)
- `c:\Users\evanw\src\fancy-links\.github\workflows\test-pr.yml` — PR validation template
- `c:\Users\evanw\src\fancy-links\package.json` — Scripts and devDependencies template
- `c:\Users\evanw\src\fancy-links\jest.config.js` — Test configuration template
- `c:\Users\evanw\src\fancy-links\test\setup.js` — Test setup template
- `c:\Users\evanw\src\fancy-links\src\utils\clean-url.js` — Dual-environment module pattern reference
- `c:\Users\evanw\src\gr-shelf-position-editor\content.js` — Source for function extraction (Phase 4)
