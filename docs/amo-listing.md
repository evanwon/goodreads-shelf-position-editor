# AMO Listing Copy

Version-controlled source of truth for the addons.mozilla.org description. Manually copy to AMO after stable releases via the AMO Developer Hub (or automate via `PATCH /api/v5/addons/addon/{slug}`).

---

## Summary (≤250 chars)

View and edit your Goodreads To Read shelf position directly on book pages and in shelf search results — no need to scroll through your full shelf.

## Description

Goodreads lets you order your To Read shelf by position, but actually editing a book's position is buried deep in the shelf UI — and when you search your shelf, the position column disappears entirely.

Goodreads Shelf Position Editor fixes both of these problems:

**On book pages:**
A small widget appears next to the shelf buttons showing the book's current position on your To Read shelf. Edit the number and press Enter or click Save to update it instantly.

**On shelf search results:**
When you search your To Read shelf, the extension adds a position column back into the results table. Each cell is editable — change a value and press Enter or Tab to save.

**How it works:**
- Uses your existing Goodreads session — no login or API keys needed
- Caches your shelf data locally for fast repeat visits (configurable TTL, default 1 week)
- All requests go directly to goodreads.com — no data is sent anywhere else
- Open source: https://github.com/evanwon/goodreads-shelf-position-editor

**Requirements:**
- Firefox 109+
- A Goodreads account with books on your To Read shelf
