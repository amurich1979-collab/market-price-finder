const { cleanTitle, nowIso, parsePrice, uniqueBy, withTimeout } = require("../utils");

const MARKETPLACE = "wb";

async function fetchWildberries(query, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.WB_TIMEOUT_MS || 12000);
  const candidates = [];
  const versions = ["v14", "v13"];

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
      if (version === versions[versions.length - 1] && candidates.length === 0) {
        throw error;
      }
    }
  }

  return uniqueBy(candidates, (item) => item.productId).slice(0, 80);
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
  fetchWildberries,
  normalizeWildberriesProduct
};
