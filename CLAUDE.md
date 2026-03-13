# Goodreads Shelf Position Editor

Firefox WebExtension that shows and edits your To Read shelf position on Goodreads book detail pages (`/book/show/*`) and shelf search results (`/review/list/*`). Chrome support is planned soon — keep cross-browser compatibility in mind when making changes (use MV3, avoid Firefox-only APIs without Chrome equivalents).

## Project Structure

```
gr-shelf-position-editor/
├── src/
│   ├── manifest.json       # Manifest V3, matches /book/show/* and /review/list/* pages
│   ├── content.js          # Book page: user discovery, shelf lookup, widget, save
│   ├── content.css         # Book page widget styles (Goodreads color palette)
│   ├── shelf.js            # Shelf search: inject position column, inline editing
│   ├── shelf.css           # Shelf search position column styles
│   ├── options.html        # Extension options page (cache TTL setting)
│   ├── options.js          # Options page logic (browser.storage.local)
│   ├── utils/
│   │   ├── parse.js        # Pure parsing/validation functions
│   │   ├── cache.js        # Cache lifecycle functions
│   │   └── shelf-api.js    # Shared API functions (user discovery, shelf data, save)
│   └── icons/              # PNG icons (16/32/48/96/128) + source SVG
├── test/
│   ├── setup.js            # Jest setup with browser API mocks
│   ├── utils/              # Unit tests (parse.test.js, cache.test.js, shelf-api.test.js)
│   ├── fixtures/           # HTML test fixtures
│   └── visual/             # Selenium visual tests
├── .github/workflows/
│   ├── test-pr.yml         # PR validation (thin caller to shared workflow)
│   └── build-release.yml   # Release build (thin caller to shared workflow)
├── docs/plans/             # Planning documents
├── .vscode/                # VS Code config (Firefox debugger)
├── package.json            # Scripts: test, build, lint, dev
├── jest.config.js          # Test configuration
├── jsconfig.json, .npmrc, .gitattributes
├── CLAUDE.md, README.md, PRIVACY.md, TODO.md, LICENSE
└── .gitignore
```

## Essential Commands

- `npm test` — Run unit tests
- `npm run test:watch` — Run tests in watch mode
- `npm run test:coverage` — Generate coverage report
- `npm run lint:firefox` — Validate extension with web-ext
- `npm run build:firefox` — Lint + build extension (.xpi)
- `npm run dev` — Run extension in Firefox with hot reload
- `npm run test:build` — Full pre-commit check (test + lint + build)
- `npm run version:bump` — Automate version bumps (commits + tags)
- `npm run version:check` — Validate manifest/package.json version consistency

## Version Management

Run `npm run version:check` to validate version consistency between `src/manifest.json` and `package.json`.

CI/CD workflows are shared via [`evanwon/browser-extension-workflows`](https://github.com/evanwon/browser-extension-workflows) (reusable GitHub Actions). Version tooling is also provided by that package:

```bash
npm run version:bump patch       # 1.0.3 -> 1.0.4
npm run version:bump rc minor    # 1.0.3 -> 1.1.0-rc1
npm run version:bump stable      # 1.1.0-rc1 -> 1.1.0
npm run version:check            # Validate manifest/package.json consistency
```

Releases are driven by git tags via the shared build-release workflow:

- **Stable release**: Push tag `v1.0.0` → tests, lint, build, AMO submission (if enabled), GitHub release
- **Pre-release**: Push tag `v1.1.0-rc1` (or `-beta`, `-alpha`) → tests, lint, build, unlisted signing, GitHub pre-release
- **Manual**: `workflow_dispatch` for testing (optional release creation, AMO channel selection)

The manifest uses both `version` (strict semver for browsers) and `version_name` (display name, can include pre-release suffix like `1.1.0-rc1`).

**GitHub configuration required for AMO submission:**
- Secrets: `AMO_API_KEY`, `AMO_API_SECRET`
- Variable: `AMO_SUBMISSION_ENABLED` (set to `true` to auto-submit stable tags)

## How It Works

### Book pages (content.js)

content.js runs on every `/book/show/*` page and executes these steps:

1. **Extract book ID** from URL path (`/book/show/(\d+)`)
2. **Extract book title** from `<meta property="og:title">` with `<title>` fallback, stripping trailing ellipsis
3. **Discover user ID + CSRF token** — tries current page inline scripts (`CurrentUserStore`), falls back to fetching homepage. User ID is cached in localStorage (`gr-book-pos-userid`)
4. **Phase 1 — title search**: `GET /review/list/{USER_ID}?shelf=to-read&view=table&search[query]={TITLE}` to confirm book is on shelf and extract review ID. Matches by book ID in href (not title string) to handle duplicates
5. **Phase 2 — shelf data lookup**: Checks localStorage cache (`gr-pos-fixer-{USER_ID}`, shared with position-fixer extension). On cache miss, paginates `GET /review/list/{USER_ID}?shelf=to-read&sort=date_added&order=d&per_page=100&page=N&view=table` to find shelf ID + position (search results don't include position inputs; non-search views do)
6. **Inject widget** near shelf buttons — shows progressive loading states, then either the position editor (`Position: [ N ] [Save] [↻]`), a "not on shelf" message, or an error
7. **Save**: `POST /shelf/move_batch/{USER_ID}` with `positions[{SHELF_ID}]=N` body. Response may be JSON or HTML; both are handled

### Shelf search pages (shelf.js)

shelf.js runs on every `/review/list/*` page and activates when a search is active on a To Read shelf:

1. **Activation check** — verifies the page is a To Read shelf with an active search query (search results strip the position column)
2. **Discover user ID + CSRF token** — same shared logic as content.js via `shelf-api.js`
3. **Inject position column** — adds a `#` header and editable position cells to each row in the search results table
4. **Resolve positions** — extracts review IDs from table rows, looks up shelf IDs and positions from cache (fetches on miss)
5. **Inline editing** — Enter or Tab saves the new position; green/red flash for success/error feedback
6. **MutationObserver** — watches for Goodreads dynamic table updates (pagination, re-sorting) and re-injects the column

## Key Technical Details

- **Manifest V3** (cross-browser; Chrome support planned). `version_name` in manifest is Chrome-specific (Firefox warns but ignores it) — keep it for future Chrome publishing
- **Two content script entries** in the manifest: one for `/book/show/*` (content.js) and one for `/review/list/*` (shelf.js). Both share `utils/parse.js`, `utils/cache.js`, and `utils/shelf-api.js` as common dependencies loaded first in content script scope
- **Shared API layer** (`shelf-api.js`): user discovery, CSRF token fetch, shelf data pagination, and position save logic are extracted into shared functions used by both content.js and shelf.js
- Content scripts use **absolute URLs** for fetch — relative URLs resolve against the extension origin
- CSRF token from `<meta name="csrf-token">` (homepage fetch, since book pages lack it)
- **Shelf IDs** (used in the save API) differ from **review IDs** (used in DOM row IDs) — the two-phase lookup maps between them
- Search results have empty position cells; only non-search shelf views include `<input name="positions[...]">`
- Goodreads API was deprecated in 2020 — all data access is via HTML page fetches with session cookies
- `og:title` on book pages is often truncated with `…` — stripped before searching

## Caching

- **User ID**: `localStorage["gr-book-pos-userid"]` — avoids slow homepage fetch on repeat visits (CSRF still needed per session)
- **Shelf data**: `localStorage["gr-pos-fixer-{USER_ID}"]` — maps `reviewId -> { shelfId, position }` for all books seen during pagination. Shared with the older position-fixer extension. First visit paginates; subsequent visits are instant cache hits
- **Timestamp**: `localStorage["gr-pos-fixer-{USER_ID}-ts"]` — tracks when shelf data was last written
- **TTL**: configurable via extension options (`browser.storage.local["cacheTtlHours"]`), default 168 hours (1 week). Set to 0 to disable caching
- **Invalidation**: cache is fully cleared after saving a position (other books' positions shift). The ↻ button in the widget also clears cache and re-fetches

## How to Test

### Automated tests
- `npm test` — unit tests for `parse.js`, `cache.js`, and `shelf-api.js`
- `npm run test:coverage` — with coverage report
- `npm run lint:firefox` — web-ext manifest/source validation

### Manual integration testing
1. `npm run dev` or `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `src/manifest.json`
2. Navigate to a book on your To Read shelf → widget shows "Loading…" then position
3. Navigate to a book NOT on your shelf → widget shows "Not on your To Read shelf"
4. Change position, press Enter or click Save → green flash, position persists on refresh
5. Navigate to your To Read shelf, search for a book → position column appears with editable values
6. Change a position in search results, press Enter → green flash, position persists on refresh
7. Console logs prefixed with `[GR Shelf Position]`
