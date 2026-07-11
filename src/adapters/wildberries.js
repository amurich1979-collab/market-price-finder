const { cleanTitle, nowIso, parsePrice, uniqueBy, withTimeout } = require("../utils");
const { normalizeApifyProduct, runActor } = require("../apify");

const MARKETPLACE = "wb";

async function fetchWildberries(query, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.WB_TIMEOUT_MS || 12000);
  const candidates = [];
  const versions = ["v14", "v13"];
  let lastError = null;

  for (const version of versions) {
    const endpoint = buildEndpoint(version, query);
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
      }, timeoutMs, "Wildberries search");

      const products = data?.data?.products || data?.products || [];
      candidates.push(...products.map(normalizeWildberriesProduct).filter((item) => item.price));
      if (candidates.length >= 50) break;
    } catch (error) {
      lastError = error;
      if (version === versions[versions.length - 1] && candidates.length === 0) {
        return fetchWildberriesFromApify(query, options).catch(() => {
          throw lastError;
        });
      }
    }
  }

  return uniqueBy(candidates, (item) => item.productId).slice(0, 80);
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
    timeoutMs: Number(process.env.WB_ACTOR_TIMEOUT_MS || 35000),
    marketplace: MARKETPLACE,
    input: {
      mode: "search",
      platforms: ["wildberries"],
      queries: [query],
      maxPagesPerQuery: Number(process.env.WB_MAX_PAGES || 1),
      maxItemsPerQuery: Number(process.env.WB_MAX_ITEMS || process.env.APIFY_MAX_ITEMS || 50),
      alertOnly: true,
      flagUnderpriced: false,
      proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ["RESIDENTIAL"],
        apifyProxyCountry: "RU"
      }
    }
  });

  return raw.map((item) => normalizeApifyProduct(item, MARKETPLACE)).filter((item) => item.price);
}

function buildEndpoint(version, query) {
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
}

function normalizeWildberriesProduct(product) {
  const prices = extractPrices(product);
  const title = cleanTitle([product.brand, product.name].filter(Boolean).join(" "));
  const productId = String(product.id || product.nmId || "");

  return {
    marketplace: MARKETPLACE,
    productId,
    title: title || "Товар Wildberries",
    price: prices.price,
    oldPrice: prices.oldPrice,
    url: productId ? `https://www.wildberries.ru/catalog/${productId}/detail.aspx` : "",
    image: buildImageUrl(productId),
    seller: product.supplier || "",
    source: "wildberries:search.wb.ru",
    fetchedAt: nowIso()
  };
}

function extractPrices(product) {
  const sizes = product.sizes || [];
  const actual = [];
  const old = [];

  for (const size of sizes) {
    const price = size.price || {};
    actual.push(price.total, price.product, price.sale, price.final);
    old.push(price.basic, price.price, price.initial);
  }

  const normalizedActual = actual.map((value) => Math.round(Number(value) / 100)).filter((value) => value > 0);
  const normalizedOld = old.map((value) => Math.round(Number(value) / 100)).filter((value) => value > 0);

  return {
    price: normalizedActual.length ? Math.min(...normalizedActual) : null,
    oldPrice: normalizedOld.length ? Math.max(...normalizedOld) : null
  };
}

function buildImageUrl(productId) {
  if (!productId) return "";
  const id = Number(productId);
  if (!Number.isFinite(id)) return "";
  const vol = Math.floor(id / 100000);
  const part = Math.floor(id / 1000);
  return `https://basket-01.wbbasket.ru/vol${vol}/part${part}/${id}/images/c516x688/1.webp`;
}

module.exports = {
  fetchWildberriesFromApify,
  fetchWildberries,
  normalizeWildberriesProduct
};
