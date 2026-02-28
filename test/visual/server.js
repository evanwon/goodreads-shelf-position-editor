const http = require("http");
const fs = require("fs");
const path = require("path");

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

// Mock Goodreads shelf search HTML — contains book 12345 (on shelf) but not 99999.
// The content script's findReviewId parses this to extract review IDs.
const SHELF_SEARCH_HTML = `
<html><head><title>to-read (1 book)</title></head><body>
<table><tbody id="booksBody">
  <tr class="bookalike review" id="review_1001">
    <td class="field title"><a href="/book/show/12345-the-great-gatsby">The Great Gatsby</a></td>
    <td class="field shelves"><a>to-read</a></td>
  </tr>
</tbody></table>
</body></html>
`;

// Route map: URL path → fixture file
const FIXTURE_ROUTES = {
  "/book/show/12345": "book-on-shelf.html",
  "/book/show/99999": "book-not-on-shelf.html",
  "/book/show/00000": "book-error.html",
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;

      // Blank page for localStorage seeding (must be same origin)
      if (pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!DOCTYPE html><html><head></head><body></body></html>");
        return;
      }

      // Mock shelf search/pagination API — serves the same HTML for any
      // /review/list/* request. The content script matches by book ID in
      // the href, so only book 12345 will be found.
      if (pathname.startsWith("/review/list/")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SHELF_SEARCH_HTML);
        return;
      }

      // Book page fixtures
      const fixtureName = FIXTURE_ROUTES[pathname];
      if (fixtureName) {
        const filePath = path.join(FIXTURES_DIR, fixtureName);
        try {
          const html = fs.readFileSync(filePath, "utf-8");
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(html);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Fixture read error: " + err.message);
        }
        return;
      }

      // 404 for everything else
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found: " + pathname);
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port });
    });

    server.on("error", reject);
  });
}

module.exports = { startServer };
