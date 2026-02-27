# TODO — Deferred Code Review Items

Items from the staff-level code review (Feb 2025) not yet implemented.
Prioritized by impact. See the full review in `.claude/plans/reflective-scribbling-wolf.md`.

## P2 — Security Hardening

- [x] **Narrow host permissions** (`manifest.json`)
  Replace `*://www.goodreads.com/*` with specific URL patterns:
  `*://www.goodreads.com/`, `*://www.goodreads.com/review/list/*`,
  `*://www.goodreads.com/shelf/move_batch/*`

- [x] **Validate position value from server** (`content.js:298`)
  Before setting `input.value = position`, verify the value is a positive integer.
  A malformed Goodreads response could show garbage in the widget.

## P3 — Code Quality / Maintainability

- [x] **Extract magic numbers to named constants** (`content.js`)
  Move `maxPages = 50`, `per_page=100`, `200ms` delay, `2000ms` flash to named constants
  at the top of the IIFE (e.g. `MAX_SHELF_PAGES`, `ITEMS_PER_PAGE`, etc.)

- [x] **Add user-facing error states** (`content.js`)
  Show a "not on To Read shelf" indicator for books that aren't shelved.
  Add a retry prompt when network requests fail (beyond the basic CSRF notice already added).

- [x] **Add cache refresh mechanism** (`content.js:115-141`)
  Cache has no TTL or manual clearing. Options:
  - Add a "refresh" button to the widget
  - Add a cache TTL (e.g. 1 hour)
  - Re-fetch position for the current book on each visit (1 request)

- [x] **Fix step numbering comments** (`content.js:256`)
  Step 5 is duplicated — the shelf lookup (line 143) and the widget injection (line 256)
  both say "Step 5". Renumber correctly.

## P4 — AMO Polish / Listing Quality

- [ ] **Add 96px icon for high-DPI displays**
  Firefox recommends 96px for toolbar and AMO listing. Add `"96": "icons/icon-96.svg"`
  to `manifest.json` icons and create the SVG.

- [x] **Add `author` and `homepage_url` to manifest**
  Optional but recommended for AMO listings. Helps establish trust.
