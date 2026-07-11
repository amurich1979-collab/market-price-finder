const { cleanTitle, nowIso, parsePrice, withTimeout } = require("./utils");

async function runActor({ actorId, token, input, timeoutMs, marketplace }) {
  if (!token) throw new Error("APIFY_TOKEN is not configured.");
  if (!actorId) throw new Error(`${marketplace} actor id is not configured.`);

  const encodedActorId = actorId.replace("/", "~");
  const deadline = Date.now() + timeoutMs;
  const started = await apifyRequest({
    token,
    pathname: `/v2/acts/${encodedActorId}/runs`,
    options: {
      method: "POST",
      body: JSON.stringify(input)
    },
    timeoutMs: remainingMs(deadline)
  });
  const run = started.data || started;

  if (!run.id) throw new Error("Apify did not return run id.");
  const finished = await waitForRun({ token, runId: run.id, deadline });

  if (finished.status !== "SUCCEEDED") {
    throw new Error(`Apify run status: ${finished.status}`);
  }

  const items = await apifyRequest({
    token,
    pathname: `/v2/datasets/${finished.defaultDatasetId}/items?clean=true&format=json`,
    timeoutMs: remainingMs(deadline)
  });

  const result = Array.isArray(items) ? items : [];
  Object.defineProperty(result, "_diagnostics", {
    enumerable: false,
    value: {
      actorId,
      runStatus: finished.status,
      defaultDatasetId: finished.defaultDatasetId,
      rawItems: result.length,
      firstItemKeys: result[0] ? Object.keys(result[0]) : []
    }
  });
  return result;
}

async function waitForRun({ token, runId, deadline }) {
  let run = await apifyRequest({ token, pathname: `/v2/actor-runs/${runId}`, timeoutMs: Math.min(10000, remainingMs(deadline)) });

  while (["READY", "RUNNING"].includes(run.data?.status || run.status)) {
    if (remainingMs(deadline) <= 0) throw new Error("Apify run timed out.");
    await new Promise((resolve) => setTimeout(resolve, Math.min(2500, remainingMs(deadline))));
    run = await apifyRequest({ token, pathname: `/v2/actor-runs/${runId}`, timeoutMs: Math.min(10000, remainingMs(deadline)) });
  }

  return run.data || run;
}

function remainingMs(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Apify request timed out.");
  return remaining;
}

async function apifyRequest({ token, pathname, options = {}, timeoutMs }) {
  return withTimeout(async (signal) => {
    const response = await fetch(`https://api.apify.com${pathname}`, {
      ...options,
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Apify ${response.status}: ${text.slice(0, 240)}`);
    }

    return response.json();
  }, timeoutMs, "Apify request");
}

function normalizeApifyProduct(item, marketplace) {
  const platform = String(item.platform || item.marketplace || marketplace).toLowerCase();
  const productId = String(item.id || item.productId || item.product_id || item.sku || item.offerId || item.offer_id || "");
  const url = item.url || item.link || item.productUrl || item.product_url || item.canonicalUrl || item.canonical_url || "";

  return {
    marketplace,
    productId,
    title: cleanTitle(item.title || item.name || item.productName || item.product_name || ""),
    price: parsePrice(item.price || item.currentPrice || item.current_price || item.priceValue || item.salePrice),
    oldPrice: parsePrice(item.oldPrice || item.originalPrice || item.beforeDiscountPrice),
    url: url || buildMarketplaceUrl(marketplace, productId),
    image: item.image || item.imageUrl || item.image_url || item.picture || item.thumbnail || "",
    seller: item.seller || item.shop || item.supplier || "",
    source: `apify:${platform}`,
    fetchedAt: item.scrapedAt || nowIso()
  };
}

function buildMarketplaceUrl(marketplace, productId) {
  if (!productId) return "";
  if (marketplace === "ozon") return `https://www.ozon.ru/product/${encodeURIComponent(productId)}/`;
  if (marketplace === "wb") return `https://www.wildberries.ru/catalog/${encodeURIComponent(productId)}/detail.aspx`;
  return "";
}

module.exports = {
  normalizeApifyProduct,
  runActor
};
