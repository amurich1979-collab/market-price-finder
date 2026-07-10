const { normalizeApifyProduct, runActor } = require("../apify");

const MARKETPLACE = "ozon";

async function fetchOzon(query, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.OZON_TIMEOUT_MS || 35000);
  const actorId = options.actorId || process.env.OZON_ACTOR_ID;
  const token = options.token || process.env.APIFY_TOKEN;

  const raw = await runActor({
    actorId,
    token,
    timeoutMs,
    marketplace: MARKETPLACE,
    input: buildOzonInput(query)
  });

  return raw
    .map((item) => normalizeApifyProduct(item, MARKETPLACE))
    .filter((item) => item.url && !isSearchUrl(item.url));
}

function buildOzonInput(query) {
  return {
    mode: "search",
    platforms: ["ozon"],
    queries: [query],
    maxPagesPerQuery: Number(process.env.OZON_MAX_PAGES || process.env.APIFY_MAX_PAGES || 1),
    maxItemsPerQuery: Number(process.env.OZON_MAX_ITEMS || process.env.APIFY_MAX_ITEMS || 50),
    alertOnly: true,
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
  fetchOzon
};
