const { cleanTitle, nowIso, parsePrice, withTimeout } = require("./utils");

const DEFAULT_ENDPOINT = "https://v2-api.scrapegraphai.com/api/extract";

async function extractMarketplaceOffers({ marketplace, query, url, timeoutMs }) {
  const apiKey = process.env.SGAI_API_KEY || process.env.SCRAPEGRAPH_API_KEY;
  if (!apiKey) {
    const empty = [];
    attachDiagnostics(empty, { configured: false, rawCandidates: 0, normalizedOffers: 0 });
    return empty;
  }

  const started = Date.now();
  const response = await scrapegraphRequest({
    apiKey,
    body: {
      url,
      prompt: buildPrompt(marketplace, query),
      schema: offersSchema(),
      mode: process.env.SCRAPEGRAPH_MODE || "prune",
      fetchConfig: buildFetchConfig()
    },
    timeoutMs: Number(timeoutMs || process.env.SCRAPEGRAPH_TIMEOUT_MS || 45000)
  });

  const rawOffers = Array.isArray(response?.json?.offers)
    ? response.json.offers
    : Array.isArray(response?.json?.products)
      ? response.json.products
      : [];
  const offers = rawOffers
    .map((item) => normalizeScrapeGraphOffer(item, marketplace))
    .filter((item) => item.title && item.price && item.url);

  attachDiagnostics(offers, {
    configured: true,
    requestId: response?.id,
    durationMs: Date.now() - started,
    rawCandidates: rawOffers.length,
    normalizedOffers: offers.length,
    missingPrice: rawOffers.filter((item) => !parsePrice(item.price || item.currentPrice || item.current_price || item.priceValue || item.salePrice)).length,
    missingOfferUrl: rawOffers.filter((item) => !(item.url || item.link || item.productUrl || item.product_url || item.canonicalUrl || item.canonical_url)).length,
    missingVariantId: rawOffers.filter((item) => marketplace === "wb" && !(item.variantId || item.variant_id || item.optionId || item.chrtId)).length,
    unverifiedOffers: offers.filter((item) => !item.verified).length
  });

  return offers;
}

async function scrapegraphRequest({ apiKey, body, timeoutMs }) {
  const endpoint = process.env.SCRAPEGRAPH_ENDPOINT || DEFAULT_ENDPOINT;

  return withTimeout(async (signal) => {
    const response = await fetch(endpoint, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "SGAI-APIKEY": apiKey
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ScrapeGraphAI ${response.status}: ${text.slice(0, 240)}`);
    }

    return response.json();
  }, timeoutMs, "ScrapeGraphAI extract");
}

function normalizeScrapeGraphOffer(item, marketplace) {
  const url = String(item.url || item.link || item.productUrl || item.product_url || item.canonicalUrl || item.canonical_url || "");
  const productId = String(item.productId || item.product_id || item.id || item.sku || productIdFromUrl(url, marketplace) || "");
  const offerId = String(item.offerId || item.offer_id || item.sku || "");
  const variantId = String(item.variantId || item.variant_id || item.optionId || item.chrtId || item.sizeId || "");
  const seller = cleanTitle(item.seller || item.shop || item.supplier || item.merchant || "");
  const price = parsePrice(item.price || item.currentPrice || item.current_price || item.priceValue || item.salePrice);
  const priceType = normalizePriceType(item.priceType || item.price_type);
  const verified = isVerified({ marketplace, url, productId, offerId, variantId, seller, price, priceType });

  return {
    marketplace,
    productId,
    offerId,
    variantId,
    title: cleanTitle(item.title || item.name || item.productName || item.product_name || ""),
    variantName: cleanTitle(item.variantName || item.variant_name || item.size || item.sizeName || item.package || ""),
    price,
    oldPrice: parsePrice(item.oldPrice || item.old_price || item.originalPrice || item.beforeDiscountPrice),
    priceType: verified ? priceType : "from",
    seller,
    url,
    image: item.image || item.imageUrl || item.image_url || item.picture || item.thumbnail || "",
    source: `scrapegraph:${marketplace}`,
    matchType: "possible",
    verified,
    fetchedAt: nowIso()
  };
}

function isVerified({ marketplace, url, productId, offerId, variantId, seller, price, priceType }) {
  if (!price || !url || priceType === "from") return false;
  if (isSearchUrl(url)) return false;
  if (marketplace === "ozon") return Boolean(productId && (seller || offerId) && /ozon\.ru\/product\//i.test(url));
  if (marketplace === "wb") return Boolean(productId && variantId && /wildberries\.ru\/catalog\//i.test(url));
  if (marketplace === "yandex") return Boolean(productId && /market\.yandex\.ru\//i.test(url));
  return false;
}

function isSearchUrl(url) {
  return /\/search\/?\?/i.test(String(url)) || /\/catalog\/0\/search/i.test(String(url));
}

function normalizePriceType(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "from" || normalized.includes("от")) return "from";
  if (normalized === "personal") return "personal";
  return "exact";
}

function productIdFromUrl(url, marketplace) {
  if (!url) return "";
  if (marketplace === "ozon") {
    const match = String(url).match(/\/product\/(?:[^/]+-)?(\d+)(?:[/?#]|$)/i);
    return match ? match[1] : "";
  }
  if (marketplace === "wb") {
    const match = String(url).match(/\/catalog\/(\d+)\/detail/i);
    return match ? match[1] : "";
  }
  const match = String(url).match(/\/(\d+)(?:[/?#]|$)/);
  return match ? match[1] : "";
}

function buildPrompt(marketplace, query) {
  return [
    `Extract marketplace product offers for the search query "${query}".`,
    "Return only offers where price, title and URL belong to the same visible product offer.",
    "Do not mix a price from one card with a URL from another card.",
    "If the page shows only a model/card price without a specific seller offer, mark priceType as from and verified as false.",
    marketplace === "ozon" ? "For Ozon, only include concrete product pages, not search pages." : "",
    marketplace === "wb" ? "For Wildberries, keep each size/variant as a separate offer when visible." : "",
    "Fields: productId, offerId, variantId, title, variantName, price, oldPrice, priceType, seller, url, image."
  ].filter(Boolean).join(" ");
}

function offersSchema() {
  return {
    type: "object",
    properties: {
      offers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            productId: { type: "string" },
            offerId: { type: "string" },
            variantId: { type: "string" },
            title: { type: "string" },
            variantName: { type: "string" },
            price: { type: ["number", "string", "null"] },
            oldPrice: { type: ["number", "string", "null"] },
            priceType: { type: "string" },
            seller: { type: "string" },
            url: { type: "string" },
            image: { type: "string" }
          },
          required: ["title", "price", "url"]
        }
      }
    },
    required: ["offers"]
  };
}

function buildFetchConfig() {
  return {
    stealth: process.env.SCRAPEGRAPH_STEALTH !== "false",
    country: process.env.SCRAPEGRAPH_COUNTRY || "ru",
    wait: Number(process.env.SCRAPEGRAPH_WAIT_MS || 3000),
    timeout: Number(process.env.SCRAPEGRAPH_FETCH_TIMEOUT_MS || 30000)
  };
}

function attachDiagnostics(items, diagnostics) {
  Object.defineProperty(items, "_diagnostics", {
    enumerable: false,
    value: diagnostics
  });
}

module.exports = {
  extractMarketplaceOffers,
  normalizeScrapeGraphOffer,
  productIdFromUrl,
  scrapegraphRequest
};
