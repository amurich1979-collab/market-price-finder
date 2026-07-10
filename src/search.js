const { fetchOzon } = require("./adapters/ozon");
const { fetchWildberries } = require("./adapters/wildberries");
const { fetchYandexMarket } = require("./adapters/yandex-market");
const { createEmptyMarketplace, logDiagnostic, nowIso, uniqueBy, withTimeout } = require("./utils");
const { filterRelevant } = require("./relevance");

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();
const inflight = new Map();

async function searchMarketplaces(query) {
  const normalized = String(query || "").trim();
  if (!normalized) {
    return createResponse("", {
      ozon: { status: "error", message: "Введите поисковый запрос.", items: [] },
      wb: { status: "error", message: "Введите поисковый запрос.", items: [] },
      yandex: { status: "error", message: "Введите поисковый запрос.", items: [] }
    });
  }

  const key = normalized.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    logDiagnostic("search.cache_hit", { query: normalized });
    return { ...cached.value, cache: { hit: true } };
  }

  if (inflight.has(key)) {
    logDiagnostic("search.inflight_join", { query: normalized });
    return inflight.get(key);
  }

  const promise = runSearch(normalized).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

async function runSearch(query) {
  const started = Date.now();
  const adapters = {
    ozon: () => fetchOzon(query),
    wb: () => fetchWildberries(query),
    yandex: () => fetchYandexMarket(query)
  };

  const entries = await Promise.all(
    Object.entries(adapters).map(async ([marketplace, adapter]) => {
      const timeoutMs = timeoutFor(marketplace);
      const adapterStarted = Date.now();

      try {
        const candidates = await withTimeout(() => adapter(), timeoutMs, `${marketplace} adapter`);
        const relevant = filterRelevant(query, dedupeProducts(candidates))
          .sort((a, b) => a.price - b.price)
          .slice(0, 3)
          .map(({ relevance, ...item }) => ({ ...item, relevanceScore: relevance.score }));

        logDiagnostic("adapter.complete", {
          marketplace,
          durationMs: Date.now() - adapterStarted,
          candidates: candidates.length,
          relevant: relevant.length,
          cacheHit: false
        });

        return [marketplace, {
          status: relevant.length ? "ok" : "empty",
          message: relevant.length ? `Найдено ${relevant.length} релевантных товаров.` : "Релевантные товары не найдены.",
          items: relevant
        }];
      } catch (error) {
        logDiagnostic("adapter.error", {
          marketplace,
          durationMs: Date.now() - adapterStarted,
          candidates: 0,
          relevant: 0,
          reason: error.message,
          cacheHit: false
        });

        return [marketplace, {
          status: "error",
          message: error.message || "Источник не ответил.",
          items: []
        }];
      }
    })
  );

  const marketplaces = {
    ozon: createEmptyMarketplace(),
    wb: createEmptyMarketplace(),
    yandex: createEmptyMarketplace()
  };

  for (const [marketplace, result] of entries) {
    marketplaces[marketplace] = result;
  }

  const response = createResponse(query, marketplaces);
  cache.set(query.toLowerCase(), { value: response, expiresAt: Date.now() + CACHE_TTL_MS });
  logDiagnostic("search.complete", { query, durationMs: Date.now() - started, cacheHit: false });
  return response;
}

function createResponse(query, marketplaces) {
  return {
    query,
    fetchedAt: nowIso(),
    marketplaces
  };
}

function dedupeProducts(items) {
  return uniqueBy(items, (item) => item.url || item.productId || `${item.title}:${item.price}`);
}

function timeoutFor(marketplace) {
  const defaults = { ozon: 35000, wb: 12000, yandex: 16000 };
  const envKey = `${marketplace.toUpperCase()}_TIMEOUT_MS`;
  return Number(process.env[envKey] || defaults[marketplace] || 15000);
}

function clearCache() {
  cache.clear();
  inflight.clear();
}

module.exports = {
  clearCache,
  searchMarketplaces
};
