const { fetchOzon } = require("./adapters/ozon");
const { fetchWildberries } = require("./adapters/wildberries");
const { fetchYandexMarket } = require("./adapters/yandex-market");
const { createEmptyMarketplace, logDiagnostic, nowIso, uniqueBy, withTimeout } = require("./utils");
const { filterRelevant } = require("./relevance");

const CACHE_TTL_MS = 15 * 60 * 1000;
const PARTIAL_CACHE_TTL_MS = 2 * 60 * 1000;
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
        const selected = selectRelevant(query, dedupeProducts(candidates));
        const relevant = selected.items;
        const adapterDebug = buildAdapterDebug(marketplace, candidates, selected, Date.now() - adapterStarted);

        logDiagnostic("adapter.complete", {
          marketplace,
          durationMs: Date.now() - adapterStarted,
          candidates: candidates.length,
          relevant: selected.relevantItems,
          cacheHit: false,
          ...(marketplace === "ozon" || marketplace === "wb" ? adapterDebug : {})
        });

        return [marketplace, {
          status: relevant.length ? "ok" : "empty",
          message: relevant.length ? `Найдено ${relevant.length} релевантных товаров.` : "Релевантные товары не найдены.",
          items: relevant,
          _debug: adapterDebug
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
          items: [],
          _debug: {
            durationMs: Date.now() - adapterStarted,
            error: error.message
          }
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
  attachDebug(response, marketplaces);
  const ttl = cacheTtlFor(Object.values(marketplaces));
  if (ttl > 0) {
    cache.set(query.toLowerCase(), { value: response, expiresAt: Date.now() + ttl });
  }
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
  const defaults = { ozon: 90000, wb: 20000, yandex: 16000 };
  const envKey = `${marketplace.toUpperCase()}_TIMEOUT_MS`;
  return Number(process.env[envKey] || defaults[marketplace] || 15000);
}

function selectRelevant(query, candidates) {
  const strict = filterRelevant(query, candidates, { minTokenOverlap: 0.72 });
  const pool = strict.length >= 3
    ? strict
    : uniqueBy([...strict, ...filterRelevant(query, candidates, { minTokenOverlap: 0.55 })], (item) => item.url || item.productId || `${item.title}:${item.price}`);
  const sorted = pool.sort((a, b) => a.price - b.price);

  return {
    relevantItems: sorted.length,
    items: sorted
      .slice(0, 3)
      .map(({ relevance, ...item }) => ({ ...item, relevanceScore: relevance.score }))
  };
}

function cacheTtlFor(results) {
  const hasItems = results.some((result) => result.items?.length);
  const hasError = results.some((result) => result.status === "error");
  const allError = results.every((result) => result.status === "error");

  if (allError) return 0;
  if (!hasItems || hasError) return PARTIAL_CACHE_TTL_MS;
  return CACHE_TTL_MS;
}

function buildAdapterDebug(marketplace, candidates, selected, durationMs) {
  const diagnostics = candidates._diagnostics || {};
  const base = {
    durationMs,
    rawItems: diagnostics.rawItems ?? candidates.length,
    normalizedItems: diagnostics.normalizedItems ?? candidates.length,
    relevantItems: selected.relevantItems
  };

  if (marketplace === "ozon") {
    return {
      actorId: diagnostics.actorId,
      runStatus: diagnostics.runStatus,
      defaultDatasetId: diagnostics.defaultDatasetId,
      firstItemKeys: diagnostics.firstItemKeys,
      droppedIncomplete: diagnostics.droppedIncomplete,
      ...base
    };
  }

  if (marketplace === "wb") {
    return {
      requestedPages: diagnostics.requestedPages,
      ...base
    };
  }

  return base;
}

function attachDebug(response, marketplaces) {
  if (process.env.DEBUG_SEARCH !== "true") {
    for (const result of Object.values(marketplaces)) delete result._debug;
    return;
  }

  response.debug = {
    ozon: marketplaces.ozon._debug,
    wb: marketplaces.wb._debug
  };
  for (const result of Object.values(marketplaces)) delete result._debug;
}

function clearCache() {
  cache.clear();
  inflight.clear();
}

module.exports = {
  cacheTtlFor,
  clearCache,
  selectRelevant,
  searchMarketplaces
};
