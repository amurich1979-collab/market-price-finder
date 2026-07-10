const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT || 5177);
const apifyToken = process.env.APIFY_TOKEN || "";
const apifyActorId = resolveApifyActorId(process.env.APIFY_ACTOR_ID);
const apifyTimeoutMs = Number(process.env.APIFY_TIMEOUT_MS || 120000);

const marketplaces = {
  ozon: {
    name: "Ozon",
    searchUrl: (query) => `https://www.ozon.ru/search/?text=${encodeURIComponent(query)}`
  },
  wb: {
    name: "Wildberries",
    searchUrl: (query) => `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(query)}`
  },
  yandex: {
    name: "Яндекс Маркет",
    searchUrl: (query) => `https://market.yandex.ru/search?text=${encodeURIComponent(query)}`
  }
};

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/search") {
    const query = (url.searchParams.get("q") || "").trim();
    try {
      sendJson(res, await searchAll(query));
    } catch (error) {
      sendJson(res, {
        results: [],
        winner: null,
        statuses: [{ marketplace: "apify", ok: false, message: error.message || "Ошибка поиска." }],
        suggestions: [],
        note: error.message || "Ошибка поиска."
      }, 500);
    }
    return;
  }

  if (url.pathname === "/api/suggest") {
    const query = (url.searchParams.get("q") || "").trim();
    sendJson(res, await suggest(query));
    return;
  }

  serveStatic(url.pathname, res);
});

server.listen(port, () => {
  console.log(`Market price finder is running at http://localhost:${port}`);
});

async function searchAll(query) {
  if (!query) {
    return { results: [], groups: [], statuses: [], suggestions: [], note: "Введите поисковый запрос." };
  }

  if (apifyToken) {
    try {
      return await searchWithApify(query);
    } catch (error) {
      const fallback = await searchDirect(query);
      fallback.statuses.unshift({
        marketplace: "apify",
        ok: false,
        message: `Apify недоступен: ${error.message}`
      });
      fallback.note = `Apify недоступен, показан запасной поиск. ${fallback.note}`;
      return fallback;
    }
  }

  return searchDirect(query);
}

async function searchDirect(query) {
  const adapters = [
    ["wb", () => searchWildberries(query)],
    ["yandex", () => searchYandexMarket(query)],
    ["ozon", () => searchOzon(query)]
  ];

  const settled = await Promise.allSettled(adapters.map(([, run]) => run()));
  const results = [];
  const statuses = [];

  settled.forEach((item, index) => {
    const marketplace = adapters[index][0];
    if (item.status === "fulfilled") {
      results.push(...item.value.results);
      statuses.push({ marketplace, ok: item.value.ok, message: item.value.message });
    } else {
      statuses.push({ marketplace, ok: false, message: item.reason?.message || "Источник не ответил." });
    }
  });

  const ranked = results
    .map((item) => ({ ...item, score: similarityScore(query, item.title) }))
    .sort((a, b) => b.score - a.score || a.price - b.price);
  const confident = ranked.filter((item) => item.score >= 35);
  const comparable = confident.length ? confident : ranked;
  const winner = comparable.filter((item) => item.price).sort((a, b) => a.price - b.price)[0] || null;

  return {
    results: ranked,
    winner,
    statuses,
    suggestions: buildSuggestions(query, ranked),
    note: buildNote(statuses, ranked)
  };
}

function resolveApifyActorId(value) {
  const fallback = "isolovyev/ru-marketplaces-price-monitor";
  const candidate = String(value || "").trim();

  if (!candidate) return fallback;
  if (candidate.includes("price-monitor-ozon-wildberries-yandex-market-avito")) return fallback;
  return candidate;
}

async function searchWithApify(query) {
  const started = await apifyRequest(`/v2/acts/${encodeURIComponentActorId(apifyActorId)}/runs?waitForFinish=${Math.ceil(apifyTimeoutMs / 1000)}`, {
    method: "POST",
    body: JSON.stringify(buildApifyInput(query))
  });
  const run = started.data || started;
  const runId = run.id;

  if (!runId) {
    return {
      results: [],
      winner: null,
      statuses: [{ marketplace: "apify", ok: false, message: "Apify не вернул ID запуска." }],
      suggestions: [],
      note: "Apify не вернул ID запуска."
    };
  }

  const finishedRun = await waitForApifyRun(runId);
  if (finishedRun.status !== "SUCCEEDED") {
    return {
      results: [],
      winner: null,
      statuses: [{ marketplace: "apify", ok: false, message: `Apify run завершился со статусом ${finishedRun.status}.` }],
      suggestions: [],
      note: `Apify run завершился со статусом ${finishedRun.status}.`
    };
  }

  const items = await apifyRequest(`/v2/datasets/${finishedRun.defaultDatasetId}/items?clean=true&format=json`);
  const rawItems = Array.isArray(items) ? items : [];
  const results = rawItems.map(normalizeApifyItem).filter((item) => item.price && item.title);
  const ranked = results
    .map((item) => ({ ...item, score: similarityScore(query, item.title) }))
    .sort((a, b) => b.score - a.score || a.price - b.price);
  const confident = ranked.filter((item) => item.score >= 35);
  const winner = (confident.length ? confident : ranked).filter((item) => item.price).sort((a, b) => a.price - b.price)[0] || null;

  return {
    results: ranked,
    winner,
    statuses: buildApifyStatuses(rawItems),
    suggestions: buildSuggestions(query, ranked),
    note: ranked.length
      ? `Apify вернул ${ranked.length} товаров. Сравнение учитывает похожесть названия.`
      : "Apify завершился, но товаров в dataset нет."
  };
}

function buildApifyInput(query) {
  return {
    mode: "search",
    platforms: ["ozon", "yandexmarket", "wildberries"],
    queries: [query],
    maxPagesPerQuery: Number(process.env.APIFY_MAX_PAGES || 1),
    maxItemsPerQuery: Number(process.env.APIFY_MAX_ITEMS || 10),
    alertOnly: true,
    flagUnderpriced: false,
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ["RESIDENTIAL"],
      apifyProxyCountry: "RU"
    }
  };
}

async function waitForApifyRun(runId) {
  const deadline = Date.now() + apifyTimeoutMs;
  let run = await apifyRequest(`/v2/actor-runs/${runId}`);

  while (["READY", "RUNNING"].includes(run.data?.status || run.status) && Date.now() < deadline) {
    await delay(2500);
    run = await apifyRequest(`/v2/actor-runs/${runId}`);
  }

  return run.data || run;
}

async function apifyRequest(pathname, options = {}) {
  const response = await fetch(`https://api.apify.com${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apifyToken}`,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Apify ${response.status}: ${text.slice(0, 240)}`);
  }

  return response.json();
}

function normalizeApifyItem(item) {
  const marketplace = normalizeMarketplace(item.platform || item.marketplace);

  return {
    marketplace,
    marketplaceName: marketplaces[marketplace]?.name || item.platform || "Marketplace",
    title: cleanTitle(item.title || item.name || ""),
    price: Number(item.price || item.currentPrice || item.priceValue || 0),
    url: item.url || item.link || marketplaces[marketplace]?.searchUrl(item.query || "") || "",
    source: "apify",
    externalId: item.id || item.productId || "",
    scrapedAt: item.scrapedAt || ""
  };
}

function normalizeMarketplace(value) {
  const key = String(value || "").toLowerCase();
  if (key === "wildberries" || key === "wb") return "wb";
  if (key === "yandexmarket" || key === "yandex_market" || key === "yandex") return "yandex";
  if (key === "ozon") return "ozon";
  return key || "unknown";
}

function buildApifyStatuses(rawItems) {
  const counts = rawItems.reduce((acc, item) => {
    const marketplace = normalizeMarketplace(item.platform || item.marketplace);
    acc[marketplace] = (acc[marketplace] || 0) + 1;
    return acc;
  }, {});

  return ["ozon", "wb", "yandex"].map((marketplace) => ({
    marketplace,
    ok: Boolean(counts[marketplace]),
    message: counts[marketplace]
      ? `Apify нашел ${counts[marketplace]} товаров.`
      : "Apify не вернул товары по этой площадке."
  }));
}

function encodeURIComponentActorId(actorId) {
  return actorId.replace("/", "~");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function suggest(query) {
  if (query.length < 2) {
    return { suggestions: [] };
  }

  const payload = await searchAll(query);
  return {
    suggestions: buildSuggestions(query, payload.results).slice(0, 10)
  };
}

async function searchWildberries(query) {
  const endpoints = ["v14", "v13"].map((version) => {
    const endpoint = new URL(`https://search.wb.ru/exactmatch/ru/common/${version}/search`);
    endpoint.searchParams.set("ab_testing", "false");
    endpoint.searchParams.set("appType", "1");
    endpoint.searchParams.set("curr", "rub");
    endpoint.searchParams.set("dest", "-1257786");
    endpoint.searchParams.set("page", "1");
    endpoint.searchParams.set("query", query);
    endpoint.searchParams.set("resultset", "catalog");
    endpoint.searchParams.set("sort", "popular");
    endpoint.searchParams.set("spp", "30");
    endpoint.searchParams.set("suppressSpellcheck", "false");
    return endpoint;
  });

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { headers: requestHeaders("application/json") });
      if (!response.ok) continue;
      const data = await response.json();
      const products = data?.data?.products || data?.products || [];
      const results = products.map(normalizeWildberriesProduct).filter((item) => item.price).slice(0, 20);
      if (results.length) {
        return { ok: true, message: `Найдено ${results.length} товаров WB.`, results };
      }
    } catch {
      // Try the next public catalog version.
    }
  }

  return { ok: false, message: "Wildberries не отдал товары по этому запросу.", results: [] };
}

async function searchYandexMarket(query) {
  const url = marketplaces.yandex.searchUrl(query);
  const response = await fetch(url, { headers: requestHeaders("text/html") });

  if (!response.ok) {
    return { ok: false, message: `Яндекс Маркет ответил ${response.status}.`, results: [] };
  }

  const html = await response.text();
  const results = parseYandexProducts(html, query).slice(0, 24);

  return results.length
    ? { ok: true, message: `Найдено ${results.length} товаров Яндекс Маркета.`, results }
    : { ok: false, message: "Яндекс Маркет открылся, но цены не удалось извлечь.", results: [] };
}

async function searchOzon(query) {
  try {
    const response = await fetch(marketplaces.ozon.searchUrl(query), {
      headers: requestHeaders("text/html"),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      return { ok: false, message: `Ozon ограничил backend-запрос (${response.status}).`, results: [] };
    }
    const html = await response.text();
    const results = parseOzonProducts(html, query).slice(0, 12);
    return results.length
      ? { ok: true, message: `Найдено ${results.length} товаров Ozon.`, results }
      : { ok: false, message: "Ozon открылся, но не отдал цены в пригодном виде.", results: [] };
  } catch {
    return { ok: false, message: "Ozon не дал получить цены из backend. Откройте поиск на площадке.", results: [] };
  }
}

function normalizeWildberriesProduct(product) {
  const sizes = product.sizes || [];
  const prices = sizes
    .map((size) => size.price?.total || size.price?.product || size.price?.basic)
    .filter(Boolean)
    .map((value) => Math.round(value / 100));
  const title = [product.brand, product.name].filter(Boolean).join(" ").trim();

  return {
    marketplace: "wb",
    marketplaceName: marketplaces.wb.name,
    title: title || "Товар Wildberries",
    price: prices.length ? Math.min(...prices) : null,
    url: product.id ? `https://www.wildberries.ru/catalog/${product.id}/detail.aspx` : marketplaces.wb.searchUrl(product.name || ""),
    source: "live"
  };
}

function parseYandexProducts(html, query) {
  const products = [];
  const seen = new Set();
  const productRegex = /"@type":"Product","@id":"((?:\\.|[^"])*)"[\s\S]{0,900}?"name":"((?:\\.|[^"])*)"[\s\S]{0,1200}?"offers":\{"@type":"Offer"[\s\S]{0,400}?"price":(\d+),"priceCurrency":"RUB"/g;
  let match;

  while ((match = productRegex.exec(html))) {
    const url = unescapeJson(match[1]);
    const title = cleanTitle(unescapeJson(match[2]));
    const price = Number(match[3]);
    const key = `${title}:${price}`;
    if (!seen.has(key) && title && price) {
      seen.add(key);
      products.push({
        marketplace: "yandex",
        marketplaceName: marketplaces.yandex.name,
        title,
        price,
        url,
        source: "live"
      });
    }
  }

  if (products.length) return products;

  const titleRegex = /alt="([^"]{12,260})"[\s\S]{0,6500}?data-auto="snippet-price-current"[\s\S]{0,500}?>([\d\s]+)<[\s\S]{0,120}?₽/g;
  while ((match = titleRegex.exec(html))) {
    const title = decodeHtml(match[1]);
    const price = Number(match[2].replace(/\D/g, ""));
    if (title && price) {
      products.push({
        marketplace: "yandex",
        marketplaceName: marketplaces.yandex.name,
        title,
        price,
        url: marketplaces.yandex.searchUrl(query),
        source: "live"
      });
    }
  }

  return products;
}

function parseOzonProducts(html, query) {
  const products = [];
  const seen = new Set();
  const regex = /"name":"((?:\\.|[^"]){8,260})"[\s\S]{0,900}?"price":"?(\d[\d\s]*)/g;
  let match;

  while ((match = regex.exec(html))) {
    const title = cleanTitle(unescapeJson(match[1]));
    const price = Number(match[2].replace(/\D/g, ""));
    const key = `${title}:${price}`;
    if (!seen.has(key) && title && price > 10) {
      seen.add(key);
      products.push({
        marketplace: "ozon",
        marketplaceName: marketplaces.ozon.name,
        title,
        price,
        url: marketplaces.ozon.searchUrl(query),
        source: "live"
      });
    }
  }

  return products;
}

function buildSuggestions(query, results) {
  const queryTokens = tokenize(query);
  const suggestions = [];
  const seen = new Set();

  for (const item of results) {
    const normalized = item.title.replace(/\s+/g, " ").trim();
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      suggestions.push({
        text: normalized,
        marketplace: item.marketplace,
        price: item.price,
        score: item.score ?? similarityScore(query, item.title)
      });
    }
  }

  const phraseSuggestions = results
    .flatMap((item) => phraseCandidates(item.title, queryTokens))
    .filter(Boolean);

  for (const text of phraseSuggestions) {
    const key = text.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      suggestions.push({ text, marketplace: "mixed", price: null, score: similarityScore(query, text) });
    }
  }

  return suggestions.sort((a, b) => b.score - a.score || (a.price || Infinity) - (b.price || Infinity)).slice(0, 12);
}

function phraseCandidates(title, queryTokens) {
  const words = title.split(/\s+/).filter((word) => word.length > 1);
  const important = words.filter((word) => /[a-zа-яё0-9]/i.test(word));
  const hasQuery = queryTokens.some((token) => important.some((word) => normalizeText(word).includes(token)));
  if (!hasQuery) return [];
  return [
    important.slice(0, 5).join(" "),
    important.slice(0, 8).join(" ")
  ];
}

function similarityScore(query, title) {
  const queryTokens = tokenize(query);
  const titleTokens = tokenize(title);
  if (!queryTokens.length || !titleTokens.length) return 0;

  let matches = 0;
  for (const token of queryTokens) {
    if (titleTokens.some((candidate) => candidate === token || candidate.includes(token) || token.includes(candidate))) {
      matches += 1;
    }
  }

  const importantBonus = queryTokens
    .filter((token) => /\d/.test(token) || /[a-z]/.test(token))
    .filter((token) => titleTokens.some((candidate) => candidate.includes(token) || token.includes(candidate))).length;

  return Math.min(100, Math.round((matches / queryTokens.length) * 82 + importantBonus * 9));
}

function tokenize(value) {
  return normalizeText(value).split(" ").filter((token) => token.length > 1);
}

function normalizeText(value) {
  return String(value)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim();
}

function buildNote(statuses, results) {
  const ok = statuses.filter((item) => item.ok).map((item) => marketplaces[item.marketplace].name);
  if (results.length && ok.length) {
    return `Живые цены получены: ${ok.join(", ")}. Сравнение учитывает похожесть названия.`;
  }
  return "Живые цены пока не получены. Попробуйте уточнить запрос или открыть поиск на площадке.";
}

function requestHeaders(accept) {
  return {
    accept,
    "accept-language": "ru-RU,ru;q=0.9,en;q=0.7",
    "cache-control": "no-cache",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
  };
}

function unescapeJson(value) {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
  } catch {
    return decodeHtml(value);
  }
}

function decodeHtml(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanTitle(value) {
  return String(value)
    .replace(/\\+"/g, '"')
    .replace(/\\+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
