const { cleanTitle, nowIso, parsePrice, withTimeout } = require("./utils");

async function runActor({ actorId, token, input, timeoutMs, marketplace }) {
  if (!token) throw new Error("APIFY_TOKEN is not configured.");
  if (!actorId) throw new Error(`${marketplace} actor id is not configured.`);

  const encodedActorId = actorId.replace("/", "~");
  const started = await apifyRequest({
    token,
    pathname: `/v2/acts/${encodedActorId}/runs?waitForFinish=${Math.ceil(timeoutMs / 1000)}`,
    options: {
      method: "POST",
      body: JSON.stringify(input)
    },
    timeoutMs
  });
  const run = started.data || started;

  if (!run.id) throw new Error("Apify did not return run id.");
  const finished = await waitForRun({ token, runId: run.id, timeoutMs });

  if (finished.status !== "SUCCEEDED") {
    throw new Error(`Apify run status: ${finished.status}`);
  }

  const items = await apifyRequest({
    token,
    pathname: `/v2/datasets/${finished.defaultDatasetId}/items?clean=true&format=json`,
    timeoutMs: 15000
  });

  return Array.isArray(items) ? items : [];
}

async function waitForRun({ token, runId, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let run = await apifyRequest({ token, pathname: `/v2/actor-runs/${runId}`, timeoutMs: 10000 });

  while (["READY", "RUNNING"].includes(run.data?.status || run.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    run = await apifyRequest({ token, pathname: `/v2/actor-runs/${runId}`, timeoutMs: 10000 });
  }

  return run.data || run;
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
  const productId = String(item.id || item.productId || item.sku || item.offerId || "");

  return {
    marketplace,
    productId,
    title: cleanTitle(item.title || item.name || ""),
    price: parsePrice(item.price || item.currentPrice || item.priceValue),
    oldPrice: parsePrice(item.oldPrice || item.originalPrice || item.beforeDiscountPrice),
    url: item.url || item.link || item.productUrl || "",
    image: item.image || item.imageUrl || item.picture || "",
    seller: item.seller || item.shop || item.supplier || "",
    source: `apify:${platform}`,
    fetchedAt: item.scrapedAt || nowIso()
  };
}

module.exports = {
  normalizeApifyProduct,
  runActor
};
