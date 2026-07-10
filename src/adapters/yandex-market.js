const { normalizeApifyProduct, runActor } = require("../apify");
const { cleanTitle, decodeHtml, nowIso, parsePrice, uniqueBy, withTimeout } = require("../utils");

const MARKETPLACE = "yandex";

async function fetchYandexMarket(query, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.YANDEX_TIMEOUT_MS || 15000);
  const htmlProducts = await fetchYandexFromPage(query, timeoutMs).catch(() => []);

  if (htmlProducts.length) {
    return htmlProducts;
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

  return raw.map((item) => normalizeApifyProduct(item, MARKETPLACE)).filter((item) => item.url);
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

  const products = [
    ...parseJsonLdProducts(html),
    ...parseEmbeddedProductPayloads(html)
  ];

  return uniqueBy(products.filter((item) => item.price && item.url), (item) => `${item.productId}:${item.price}`);
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
    const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
    products.push(normalizeYandexProduct({
      id: node.sku || node.productID || node["@id"],
      title: node.name,
      price: offer?.price,
      oldPrice: null,
      url: offer?.url || node.url || node["@id"],
      image: Array.isArray(node.image) ? node.image[0] : node.image,
      seller: offer?.seller?.name
    }));
  }

  Object.values(node).forEach((value) => collectJsonLdProducts(value, products));
}

function parseEmbeddedProductPayloads(html) {
  const products = [];
  const productFragments = html.match(/"@type":"Product"[\s\S]{0,2500}?"priceCurrency":"RUB"/g) || [];

  for (const fragment of productFragments) {
    const title = pickJsonString(fragment, "name");
    const url = pickJsonString(fragment, "url") || pickJsonString(fragment, "@id");
    const image = pickJsonString(fragment, "image");
    const priceMatch = fragment.match(/"price":(\d+)/);
    const price = priceMatch ? Number(priceMatch[1]) : null;

    if (title && url && price) {
      products.push(normalizeYandexProduct({
        id: pickIdFromUrl(url),
        title,
        price,
        url,
        image
      }));
    }
  }

  return products;
}

function pickJsonString(fragment, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = fragment.match(new RegExp(`"${escaped}":"((?:\\\\.|[^"])*)"`));
  if (!match) return "";
  try {
    return cleanTitle(JSON.parse(`"${match[1].replace(/"/g, '\\"')}"`));
  } catch {
    return cleanTitle(match[1]);
  }
}

function pickIdFromUrl(url) {
  const match = String(url).match(/\/(\d+)(?:[/?#]|$)/);
  return match ? match[1] : String(url);
}

function normalizeYandexProduct(item) {
  return {
    marketplace: MARKETPLACE,
    productId: String(item.id || pickIdFromUrl(item.url || "")),
    title: cleanTitle(item.title),
    price: parsePrice(item.price),
    oldPrice: parsePrice(item.oldPrice),
    url: item.url || "",
    image: item.image || "",
    seller: item.seller || "",
    source: "yandex:page-json",
    fetchedAt: nowIso()
  };
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

module.exports = {
  fetchYandexMarket,
  parseEmbeddedProductPayloads,
  parseJsonLdProducts
};
