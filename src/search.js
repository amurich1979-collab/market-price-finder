const { fetchWildberries } = require("./adapters/wildberries");
const { fetchYandexMarket } = require("./adapters/yandex-market");
const { logDiagnostic, nowIso, uniqueBy, withTimeout } = require("./utils");
const { filterRelevant } = require("./relevance");

const CACHE_TTL_MS = 10 * 60 * 1000;
const PARTIAL_CACHE_TTL_MS = 60 * 1000;
const cache = new Map();
const inflight = new Map();

async function searchMarketplaces(query) {
  const normalized = String(query || "").trim();
  if (!normalized) {
    return createResponse("", {
      wb: createMarketplaceResult("error", "Введите поисковый запрос.", []),
      yandex: createMarketplaceResult("error", "Введите поисковый запрос.", []),
      ozon: ozonUnavailable()
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
    wb: () => fetchWildberries(query),
    yandex: () => fetchYandexMarket(query)
  };

  const entries = await Promise.all(
    Object.entries(adapters).map(([marketplace, adapter]) => runAdapter({ marketplace, adapter, query }))
  );

  const marketplaces = {
    wb: createMarketplaceResult("error", "Источник не запускался.", []),
    yandex: createMarketplaceResult("error", "Источник не запускался.", []),
    ozon: ozonUnavailable()
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

async function runAdapter({ marketplace, adapter, query }) {
  const timeoutMs = timeoutFor(marketplace);
  const adapterStarted = Date.now();

  try {
    const candidates = await withTimeout(() => adapter(), timeoutMs, `${marketplace} adapter`);
    const selected = selectRelevant(query, dedupeProducts(candidates));
    const debug = buildAdapterDebug(candidates, selected, Date.now() - adapterStarted);

    logDiagnostic("adapter.complete", {
      marketplace,
      cacheHit: false,
      ...debug
    });

    return [marketplace, {
      status: selected.items.length ? "ok" : "empty",
      message: selected.items.length ? `Найдено ${selected.items.length} предложения` : "Релевантные предложения не найдены.",
      items: selected.items,
      _debug: debug
    }];
  } catch (error) {
    const debug = {
      durationMs: Date.now() - adapterStarted,
      rawCandidates: 0,
      normalizedOffers: 0,
      strictMatches: 0,
      relaxedMatches: 0,
      missingPrice: 0,
      missingOfferUrl: 0,
      missingVariantId: 0,
      unverifiedOffers: 0,
      error: error.message
    };
    logDiagnostic("adapter.error", {
      marketplace,
      reason: error.message,
      cacheHit: false,
      ...debug
    });

    return [marketplace, {
      status: "error",
      message: error.message || "Источник не ответил.",
      items: [],
      _debug: debug
    }];
  }
}

function selectRelevant(query, candidates) {
  const strict = filterRelevant(query, candidates, { minTokenOverlap: 0.72 })
    .map((item) => markMatch(item, "exact"));
  const relaxed = strict.length >= 3
    ? []
    : filterRelevant(query, candidates, { minTokenOverlap: 0.5 })
      .map((item) => markMatch(item, "possible"))
      .filter((item) => !strict.some((strictItem) => dedupeKey(strictItem) === dedupeKey(item)));
  const combined = uniqueBy([...strict, ...relaxed], dedupeKey).sort(compareOffers);

  return {
    strictMatches: strict.length,
    relaxedMatches: relaxed.length,
    relevantItems: combined.length,
    items: combined
      .slice(0, 3)
      .map(({ relevance, ...item }) => ({ ...item, relevanceScore: relevance.score }))
  };
}

function markMatch(item, matchType) {
  return { ...item, matchType };
}

function compareOffers(a, b) {
  if (Boolean(a.verified) !== Boolean(b.verified)) return a.verified ? -1 : 1;
  if (a.matchType !== b.matchType) return a.matchType === "exact" ? -1 : 1;
  return (a.price || Number.MAX_SAFE_INTEGER) - (b.price || Number.MAX_SAFE_INTEGER);
}

function dedupeProducts(items) {
  return uniqueBy(items, dedupeKey);
}

function dedupeKey(item) {
  if (item.marketplace === "wb") return `${item.marketplace}:${item.productId}:${item.variantId}`;
  if (item.marketplace === "yandex") return `${item.marketplace}:${item.productId}:${item.offerId || item.url}`;
  if (item.marketplace === "ozon") return `${item.marketplace}:${item.productId}:${item.offerId || item.url}`;
  return `${item.marketplace}:${item.url || item.productId || item.title}:${item.price}`;
}

function buildAdapterDebug(candidates, selected, durationMs) {
  const diagnostics = candidates._diagnostics || {};
  return {
    durationMs,
    rawCandidates: diagnostics.rawCandidates ?? diagnostics.rawItems ?? candidates.length,
    normalizedOffers: diagnostics.normalizedOffers ?? diagnostics.normalizedItems ?? candidates.length,
    strictMatches: selected.strictMatches,
    relaxedMatches: selected.relaxedMatches,
    missingPrice: diagnostics.missingPrice ?? candidates.filter((item) => !item.price).length,
    missingOfferUrl: diagnostics.missingOfferUrl ?? candidates.filter((item) => !item.url).length,
    missingVariantId: diagnostics.missingVariantId ?? candidates.filter((item) => item.marketplace === "wb" && !item.variantId).length,
    unverifiedOffers: diagnostics.unverifiedOffers ?? candidates.filter((item) => !item.verified).length
  };
}

function timeoutFor(marketplace) {
  const defaults = { wb: 12000, yandex: 15000 };
  const envKey = `${marketplace.toUpperCase()}_TIMEOUT_MS`;
  return Number(process.env[envKey] || defaults[marketplace] || 15000);
}

function cacheTtlFor(results) {
  const searchable = results.filter((result) => result.status !== "unavailable");
  const hasItems = searchable.some((result) => result.items?.length);
  const allOk = searchable.length > 0 && searchable.every((result) => result.status === "ok");

  if (!hasItems) return 0;
  if (allOk) return CACHE_TTL_MS;
  return PARTIAL_CACHE_TTL_MS;
}

function createMarketplaceResult(status, message, items) {
  return { status, message, items };
}

function ozonUnavailable() {
  return createMarketplaceResult("unavailable", "Источник Ozon пока не настроен", []);
}

function createResponse(query, marketplaces) {
  return {
    query,
    fetchedAt: nowIso(),
    marketplaces
  };
}

function attachDebug(response, marketplaces) {
  if (process.env.DEBUG_SEARCH !== "true") {
    for (const result of Object.values(marketplaces)) delete result._debug;
    return;
  }

  response.debug = {
    wb: marketplaces.wb._debug,
    yandex: marketplaces.yandex._debug
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
  compareOffers,
  dedupeKey,
  selectRelevant,
  searchMarketplaces
};
