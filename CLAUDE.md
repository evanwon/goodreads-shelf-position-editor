# GR Shelf Position Editor

Firefox WebExtension that shows and edits your To Read shelf position directly on Goodreads book detail pages (`/book/show/*`).

## Project Structure

```
gr-shelf-position-editor/
├── manifest.json       # Manifest V2, matches /book/show/* pages
├── content.js          # All logic: discover user, find book, inject widget, save
├── content.css         # Widget styles (Goodreads color palette)
├── icons/icon-48.svg
├── _archive/           # Previous approaches (gitignored)
├── .gitignore
├── CLAUDE.md
└── README.md
```

## How It Works

content.js runs on every `/book/show/*` page and executes these steps:

1. **Extract book ID** from URL path (`/book/show/(\d+)`)
2. **Extract book title** from `<meta property="og:title">` with `<title>` fallback, stripping trailing ellipsis
3. **Discover user ID + CSRF token** — tries current page inline scripts (`CurrentUserStore`), falls back to fetching homepage. User ID is cached in localStorage (`gr-book-pos-userid`)
4. **Phase 1 — title search**: `GET /review/list/{USER_ID}?shelf=to-read&view=table&search[query]={TITLE}` to confirm book is on shelf and extract review ID. Matches by book ID in href (not title string) to handle duplicates
5. **Phase 2 — shelf data lookup**: Checks localStorage cache (`gr-pos-fixer-{USER_ID}`, shared with position-fixer extension). On cache miss, paginates `GET /review/list/{USER_ID}?shelf=to-read&sort=date_added&order=d&per_page=100&page=N&view=table` to find shelf ID + position (search results don't include position inputs; non-search views do)
6. **Inject widget** near shelf buttons: `To Read position: [ N ] [Save]`
7. **Save**: `POST /shelf/move_batch/{USER_ID}` with `positions[{SHELF_ID}]=N` body. Response may be JSON or HTML; both are handled

## Key Technical Details

- **Manifest V2** (Firefox preferred for temporary add-ons via `about:debugging`)
- Content scripts use **absolute URLs** for fetch — relative URLs resolve against the extension origin
- CSRF token from `<meta name="csrf-token">` (homepage fetch, since book pages lack it)
- **Shelf IDs** (used in the save API) differ from **review IDs** (used in DOM row IDs) — the two-phase lookup maps between them
- Search results have empty position cells; only non-search shelf views include `<input name="positions[...]">`
- Goodreads API was deprecated in 2020 — all data access is via HTML page fetches with session cookies
- `og:title` on book pages is often truncated with `…` — stripped before searching

## Caching

- **User ID**: `localStorage["gr-book-pos-userid"]` — avoids slow homepage fetch on repeat visits (CSRF still needed per session)
- **Shelf data**: `localStorage["gr-pos-fixer-{USER_ID}"]` — maps `reviewId -> { shelfId, position }` for all books seen during pagination. Shared with the older position-fixer extension. First visit paginates; subsequent visits are instant cache hits
- Positions go stale after external changes; shelf IDs remain stable
- No TTL on cache

## How to Test

1. `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `manifest.json`
2. Navigate to a book on your To Read shelf → widget appears with current position
3. Navigate to a book NOT on your shelf → no widget, console shows "Book not found on To Read shelf"
4. Change position, press Enter or click Save → green flash, position persists on refresh
5. Console logs prefixed with `[GR Shelf Position]`
