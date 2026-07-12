const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadEnvFile } = require("./src/env");

loadEnvFile();

const { searchMarketplaces } = require("./src/search");

const root = __dirname;
const port = Number(process.env.PORT || 5177);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    sendJson(res, { status: "ok", service: "market-price-finder", at: new Date().toISOString() });
    return;
  }

  if (url.pathname === "/api/search") {
    const query = (url.searchParams.get("q") || "").trim();
    try {
      sendJson(res, await searchMarketplaces(query));
    } catch (error) {
      sendJson(res, {
        query,
        fetchedAt: new Date().toISOString(),
        marketplaces: {
          ozon: { status: "error", message: error.message || "Ошибка поиска.", items: [] },
          wb: { status: "error", message: error.message || "Ошибка поиска.", items: [] },
          yandex: { status: "error", message: error.message || "Ошибка поиска.", items: [] }
        }
      }, 500);
    }
    return;
  }

  if (url.pathname === "/api/suggest") {
    sendJson(res, { suggestions: [] });
    return;
  }

  if (url.pathname === "/lite.html") {
    redirect(res, "/index.html");
    return;
  }

  serveStatic(url.pathname, res);
});

server.listen(port, () => {
  console.log(`Market price finder is running at http://localhost:${port}`);
});

function serveStatic(pathname, res) {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(root, relative));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": mime[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}
