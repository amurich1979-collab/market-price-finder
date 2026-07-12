const { normalizeApifyProduct, runActor } = require("../apify");

const MARKETPLACE = "ozon";

async function fetchOzon(query, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.OZON_TIMEOUT_MS || 90000);
  const actorId = options.actorId || process.env.OZON_ACTOR_ID || process.env.APIFY_ACTOR_ID;
  const token = options.token || process.env.APIFY_TOKEN;

  const raw = await runActor({
    actorId,
    token,
    timeoutMs,
    marketplace: MARKETPLACE,
    input: buildOzonInput(query)
  });

  const normalized = raw
    .map((item) => normalizeApifyProduct(item, MARKETPLACE))
    .filter((item) => !isSearchUrl(item.url));
  const items = normalized.filter((item) => item.productId && item.title && item.price && item.url && (item.seller || item.offerId) && item.verified);
  const droppedIncomplete = normalized.length - items.length;

  Object.defineProperty(items, "_diagnostics", {
    enumerable: false,
    value: {
      ...(raw._diagnostics || {}),
      normalizedItems: normalized.length,
      droppedIncomplete
    }
  });

  return items;
}

function buildOzonInput(query) {
  return {
    mode: "search",
    platforms: ["ozon"],
    queries: [query],
    maxPagesPerQuery: Number(process.env.OZON_MAX_PAGES || process.env.APIFY_MAX_PAGES || 1),
    maxItemsPerQuery: Number(process.env.OZON_MAX_ITEMS || process.env.APIFY_MAX_ITEMS || 50),
    alertOnly: false,
    flagUnderpriced: false,
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ["RESIDENTIAL"],
      apifyProxyCountry: "RU"
    }
  };
}

function isSearchUrl(url) {
  return /\/search\/?\?/.test(String(url));
}

module.exports = {
  buildOzonInput,
  fetchOzon,
  isSearchUrl
};
