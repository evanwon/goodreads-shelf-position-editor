# Privacy Policy

Goodreads Shelf Position Editor is a browser extension that displays and edits your To Read shelf position on Goodreads book pages and shelf search results.

## Data Collected

This extension accesses the following data from Goodreads pages you visit:

- **Your Goodreads user ID** — extracted from page scripts to make shelf API requests
- **Your To Read shelf data** — book positions and shelf IDs, fetched via Goodreads page requests
- **CSRF token** — extracted from page metadata, used to authenticate save requests

## Data Storage

- Your Goodreads user ID is cached in your browser's `localStorage` to avoid re-fetching it on every page load
- Shelf position data (shelf IDs and positions) is cached in `localStorage` to speed up repeated visits
- All cached data is stored locally in your browser and is never transmitted to any external service

## Network Requests

This extension makes requests **only** to `www.goodreads.com` using your existing Goodreads session cookies. Specifically:

- `GET /` — to discover your user ID and CSRF token (if not available on the current page)
- `GET /review/list/{userId}` — to search your To Read shelf and retrieve position data
- `POST /shelf/move_batch/{userId}` — to save a new shelf position when you click Save

## Third-Party Sharing

This extension does **not** send any data to third parties. No analytics, tracking, or telemetry of any kind is included.

## Data Deletion

Cached data can be cleared by:
- Clearing your browser's site data for `www.goodreads.com`
- Removing the extension

## Contact

For questions about this privacy policy, please open an issue on the project's GitHub repository.
