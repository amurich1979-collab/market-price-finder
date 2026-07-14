const { cleanTitle, nowIso, uniqueBy, withTimeout } = require("../utils");
const { normalizeApifyProduct, runActor } = require("../apify");
const { extractMarketplaceOffers } = require("../scrapegraph");

const MARKETPLACE = "wb";
const PAGES = [1, 2, 3];

async function fetchWildberries(query, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.WB_TIMEOUT_MS || 12000);
  const candidates = [];
  const versions = ["v14", "v13"];
  const requestedPages = [];
  let lastError = null;

  for (const version of versions) {
    for (const page of PAGES) {
      const endpoint = buildEndpoint(version, query, page);
      requestedPages.push(`${version}:${page}`);

      try {
        const data = await withTimeout(async (signal) => {
          const response = await fetch(endpoint, {
            signal,
            headers: {
              accept: "application/json",
              "accept-language": "ru-RU,ru;q=0.9,en;q=0.7",
              "user-agent": "Mozilla/5.0 price-finder"
            }
          });
          if (!response.ok) throw new Error(`WB responded ${response.status}`);
          return response.json();
        }, Math.min(timeoutMs, 5000), "Wildberries search page");

        const products = data?.data?.products || data?.products || [];
        candidates.push(...products.flatMap(normalizeWildberriesProduct).filter((item) => item.price));
        if (uniqueBy(candidates, offerKey).length >= 100) break;
      } catch (error) {
        lastError = error;
        if (version === versions[versions.length - 1] && page === PAGES[PAGES.length - 1] && candidates.length === 0) {
          const scrapeGraphItems = await fetchWildberriesFromScrapeGraph(query, options).catch(() => []);
          if (scrapeGraphItems.length) return scrapeGraphItems;
          return fetchWildberriesFromApify(query, options).catch(() => {
            throw lastError;
          });
        }
      }
    }

    if (uniqueBy(candidates, offerKey).length >= 100) break;
  }

  const items = uniqueBy(candidates, offerKey).slice(0, 120);
  if (!items.length) {
    const scrapeGraphItems = await fetchWildberriesFromScrapeGraph(query, options).catch(() => []);
    if (scrapeGraphItems.length) return scrapeGraphItems;
  }
  Object.defineProperty(items, "_diagnostics", {
    enumerable: false,
    value: {
      requestedPages,
      rawCandidates: candidates.length,
      normalizedOffers: items.length,
      missingPrice: candidates.filter((item) => !item.price).length,
      missingVariantId: candidates.filter((item) => !item.variantId).length,
      missingOfferUrl: candidates.filter((item) => !item.url).length,
      unverifiedOffers: candidates.filter((item) => !item.verified).length
    }
  });
  return items;
}

async function fetchWildberriesFromScrapeGraph(query, options = {}) {
  return extractMarketplaceOffers({
    marketplace: MARKETPLACE,
    query,
    url: `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(query)}`,
    timeoutMs: options.scrapeGraphTimeoutMs || process.env.WB_SCRAPEGRAPH_TIMEOUT_MS || process.env.SCRAPEGRAPH_TIMEOUT_MS
  });
}

async function fetchWildberriesFromApify(query, options = {}) {
  const actorId = options.actorId || process.env.WB_ACTOR_ID || process.env.APIFY_ACTOR_ID;
  const token = options.token || process.env.APIFY_TOKEN;

  if (!actorId || !token) {
    throw new Error("WB public endpoint failed and WB Apify fallback is not configured.");
  }

  const raw = await runActor({
    actorId,
    token,
    timeoutMs: Number(process.env.WB_ACTOR_TIMEOUT_MS || 90000),
    marketplace: MARKETPLACE,
    input: {
      mode: "search",
      platforms: ["wildberries"],
      queries: [query],
      maxPagesPerQuery: Number(process.env.WB_MAX_PAGES || 1),
      maxItemsPerQuery: Number(process.env.WB_MAX_ITEMS || process.env.APIFY_MAX_ITEMS || 50),
      alertOnly: false,
      flagUnderpriced: false,
      proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ["RESIDENTIAL"],
        apifyProxyCountry: "RU"
      }
    }
  });

  return raw
    .map((item) => normalizeApifyProduct(item, MARKETPLACE))
    .filter((item) => item.price && item.url);
}

function buildEndpoint(version, query, page = 1) {
  const endpoint = new URL(`https://search.wb.ru/exactmatch/ru/common/${version}/search`);
  endpoint.searchParams.set("ab_testing", "false");
  endpoint.searchParams.set("appType", "1");
  endpoint.searchParams.set("curr", "rub");
  endpoint.searchParams.set("dest", "-1257786");
  endpoint.searchParams.set("page", String(page));
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("resultset", "catalog");
  endpoint.searchParams.set("spp", "30");
  endpoint.searchParams.set("suppressSpellcheck", "false");
  return endpoint;
}

function normalizeWildberriesProduct(product) {
  const title = cleanTitle([product.brand, product.name].filter(Boolean).join(" "));
  const productId = String(product.id || product.nmId || "");
  const base = {
    marketplace: MARKETPLACE,
    productId,
    offerId: "",
    title: title || "Товар Wildberries",
    url: productId ? `https://www.wildberries.ru/catalog/${productId}/detail.aspx` : "",
    image: "",
    seller: product.supplier || "",
    source: "wildberries:search.wb.ru",
    fetchedAt: nowIso()
  };
  const sizes = Array.isArray(product.sizes) ? product.sizes : [];
  const offers = sizes
    .map((size) => normalizeWildberriesSizeOffer(size, base))
    .filter((item) => item.price);

  if (offers.length) return offers;

  const fallbackPrices = extractProductFallbackPrices(product);
  if (!fallbackPrices.price) return [];

  return [{
    ...base,
    variantId: "",
    variantName: "",
    price: fallbackPrices.price,
    oldPrice: fallbackPrices.oldPrice,
    priceType: "from",
    matchType: "possible",
    verified: false
  }];
}

function normalizeWildberriesSizeOffer(size, base) {
  const prices = extractSizePrices(size);
  const variantId = String(size.optionId || size.chrtId || size.id || "");
  const variantName = cleanTitle(size.origName || size.name || "");

  return {
    ...base,
    offerId: variantId,
    variantId,
    variantName,
    price: prices.price,
    oldPrice: prices.oldPrice,
    priceType: "exact",
    matchType: "possible",
    verified: Boolean(base.productId && variantId && prices.price)
  };
}

function extractSizePrices(size) {
  const price = size?.price || {};
  return selectPrices([
    normalizeWbPrice(price.total, true),
    normalizeWbPrice(price.product, true),
    normalizeWbPrice(price.sale, true),
    normalizeWbPrice(price.final, true),
    normalizeWbPrice(price.salePriceU, true),
    normalizeWbPrice(price.priceU, true)
  ], [
    normalizeWbPrice(price.basic, true),
    normalizeWbPrice(price.price, true),
    normalizeWbPrice(price.initial, true),
    normalizeWbPrice(price.basicPriceU, true)
  ]);
}

function extractProductFallbackPrices(product) {
  return selectPrices([
    normalizeWbPrice(product.salePriceU, true),
    normalizeWbPrice(product.priceU, true),
    normalizeWbPrice(product.salePrice, false),
    normalizeWbPrice(product.price, false),
    normalizeWbPrice(product.extended?.clientPriceU, true)
  ], [
    normalizeWbPrice(product.extended?.basicPriceU, true)
  ]);
}

function selectPrices(actual, old) {
  const normalizedActual = actual.filter((value) => value > 0);
  const normalizedOld = old.filter((value) => value > 0);

  return {
    price: normalizedActual.length ? Math.min(...normalizedActual) : null,
    oldPrice: normalizedOld.length ? Math.max(...normalizedOld) : null
  };
}

function normalizeWbPrice(value, priceU = false) {
  if (value == null) return null;
  const number = Number(String(value).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(priceU ? number / 100 : number);
}

function offerKey(item) {
  return `${item.marketplace}:${item.productId}:${item.variantId}`;
}

module.exports = {
  buildEndpoint,
  extractProductFallbackPrices,
  extractSizePrices,
  fetchWildberriesFromScrapeGraph,
  fetchWildberriesFromApify,
  fetchWildberries,
  normalizeWbPrice,
  normalizeWildberriesProduct,
  normalizeWildberriesSizeOffer,
  offerKey
};
