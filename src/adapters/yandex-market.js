const { normalizeApifyProduct, runActor } = require("../apify");
const { extractMarketplaceOffers } = require("../scrapegraph");
const { cleanTitle, decodeHtml, nowIso, parsePrice, uniqueBy, withTimeout } = require("../utils");

const MARKETPLACE = "yandex";

async function fetchYandexMarket(query, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.YANDEX_TIMEOUT_MS || 15000);
  const pageOffers = await fetchYandexFromPage(query, timeoutMs).catch(() => []);

  if (pageOffers.length) {
    return pageOffers;
  }

  const scrapeGraphOffers = await fetchYandexFromScrapeGraph(query, options).catch(() => []);
  if (scrapeGraphOffers.length) {
    return scrapeGraphOffers;
  }

  const actorId = options.actorId || process.env.YANDEX_ACTOR_ID;
  if (!actorId) return [];

  const raw = await runActor({
    actorId,
    token: options.token || process.env.APIFY_TOKEN,
    timeoutMs: Number(process.env.YANDEX_ACTOR_TIMEOUT_MS || 35000),
    marketplace: MARKETPLACE,
    input: buildYandexInput(query)
  });

  return raw
    .map((item) => normalizeApifyProduct(item, MARKETPLACE))
    .filter((item) => item.price && item.url);
}

async function fetchYandexFromScrapeGraph(query, options = {}) {
  return extractMarketplaceOffers({
    marketplace: MARKETPLACE,
    query,
    url: `https://market.yandex.ru/search?text=${encodeURIComponent(query)}`,
    timeoutMs: options.scrapeGraphTimeoutMs || process.env.YANDEX_SCRAPEGRAPH_TIMEOUT_MS || process.env.SCRAPEGRAPH_TIMEOUT_MS
  });
}

async function fetchYandexFromPage(query, timeoutMs) {
  const url = `https://market.yandex.ru/search?text=${encodeURIComponent(query)}`;
  const html = await withTimeout(async (signal) => {
    const response = await fetch(url, {
      signal,
      headers: {
        accept: "text/html",
        "accept-language": "ru-RU,ru;q=0.9,en;q=0.7",
        "user-agent": "Mozilla/5.0 price-finder"
      }
    });
    if (!response.ok) throw new Error(`Yandex Market responded ${response.status}`);
    return response.text();
  }, timeoutMs, "Yandex Market page");

  const offers = parseJsonLdProducts(html).filter((item) => item.price && item.url);
  const items = uniqueBy(offers, offerKey);
  Object.defineProperty(items, "_diagnostics", {
    enumerable: false,
    value: {
      rawCandidates: offers.length,
      normalizedOffers: items.length,
      missingPrice: offers.filter((item) => !item.price).length,
      missingOfferUrl: offers.filter((item) => !item.url).length,
      missingVariantId: 0,
      unverifiedOffers: offers.filter((item) => !item.verified).length
    }
  });
  return items;
}

function parseJsonLdProducts(html) {
  const products = [];
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];

  for (const script of scripts) {
    const text = decodeHtml(script[1]).trim();
    try {
      const parsed = JSON.parse(text);
      collectJsonLdProducts(parsed, products);
    } catch {
      // Ignore malformed ld-json.
    }
  }

  return products;
}

function collectJsonLdProducts(node, products) {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectJsonLdProducts(item, products));
    return;
  }
  if (typeof node !== "object") return;

  if (node["@type"] === "Product") {
    const offers = Array.isArray(node.offers) ? node.offers : [node.offers].filter(Boolean);
    for (const offer of offers) {
      products.push(normalizeYandexOffer(node, offer));
    }
  }

  Object.values(node).forEach((value) => collectJsonLdProducts(value, products));
}

function normalizeYandexOffer(product, offer = {}) {
  const offerUrl = offer.url || "";
  const fallbackUrl = product.url || product["@id"] || "";
  const productId = String(product.sku || product.productID || pickIdFromUrl(fallbackUrl) || product["@id"] || "");
  const offerId = String(offer.sku || offer.offerId || offer["@id"] || pickIdFromUrl(offerUrl) || "");
  const verified = Boolean(offerUrl && offer.price);

  return {
    marketplace: MARKETPLACE,
    productId,
    offerId,
    variantId: "",
    title: cleanTitle(product.name),
    variantName: cleanTitle(offer.name || ""),
    price: parsePrice(offer.price || offer.lowPrice),
    oldPrice: parsePrice(offer.highPrice || offer.oldPrice),
    priceType: verified ? "exact" : "from",
    seller: offer.seller?.name || offer.offeredBy?.name || "",
    url: offerUrl || fallbackUrl,
    image: Array.isArray(product.image) ? product.image[0] : product.image || "",
    source: "yandex:json-ld",
    matchType: "possible",
    verified,
    fetchedAt: nowIso()
  };
}

function parseEmbeddedProductPayloads() {
  return [];
}

function pickIdFromUrl(url) {
  const match = String(url).match(/\/(\d+)(?:[/?#]|$)/);
  return match ? match[1] : "";
}

function buildYandexInput(query) {
  return {
    mode: "search",
    platforms: ["yandexmarket"],
    queries: [query],
    maxPagesPerQuery: Number(process.env.YANDEX_MAX_PAGES || 1),
    maxItemsPerQuery: Number(process.env.YANDEX_MAX_ITEMS || 50)
  };
}

function offerKey(item) {
  return `${item.marketplace}:${item.productId}:${item.offerId || item.url}`;
}

module.exports = {
  fetchYandexMarket,
  fetchYandexFromScrapeGraph,
  normalizeYandexOffer,
  offerKey,
  parseEmbeddedProductPayloads,
  parseJsonLdProducts
};
