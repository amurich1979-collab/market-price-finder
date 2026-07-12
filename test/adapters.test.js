const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeApifyProduct, runActor } = require("../src/apify");
const { cacheTtlFor, dedupeKey, selectRelevant, searchMarketplaces } = require("../src/search");
const {
  extractProductFallbackPrices,
  extractSizePrices,
  fetchWildberries,
  normalizeWildberriesProduct
} = require("../src/adapters/wildberries");
const {
  normalizeYandexOffer,
  parseJsonLdProducts
} = require("../src/adapters/yandex-market");

function responseJson(payload) {
  return {
    ok: true,
    json: async () => payload
  };
}

function responseText(payload) {
  return {
    ok: true,
    text: async () => payload
  };
}

function wbProduct(id, page = 1) {
  return {
    id,
    brand: "Apple",
    name: `iPhone 15 128GB ${page}-${id}`,
    sizes: [
      { optionId: `${id}-a`, name: "128GB black", price: { total: 100000 } },
      { optionId: `${id}-b`, name: "128GB blue", price: { total: 110000 } }
    ]
  };
}

test("WB turns two sizes into two separate offers", () => {
  const offers = normalizeWildberriesProduct(wbProduct(101));

  assert.equal(offers.length, 2);
  assert.deepEqual(offers.map((item) => item.variantId), ["101-a", "101-b"]);
  assert.deepEqual(offers.map((item) => item.price), [1000, 1100]);
});

test("WB does not assign one variant minimum price to the whole card", () => {
  const offers = normalizeWildberriesProduct({
    id: 77,
    brand: "Dyson",
    name: "V8",
    sizes: [
      { optionId: "basic", name: "basic", price: { total: 3000000 } },
      { optionId: "kit", name: "complete kit", price: { total: 4500000 } }
    ]
  });

  assert.deepEqual(offers.map((item) => item.price), [30000, 45000]);
  assert.equal(offers.find((item) => item.variantId === "kit").price, 45000);
});

test("WB extracts price from size.price", () => {
  assert.deepEqual(extractSizePrices({ price: { final: 99000, basic: 150000 } }), {
    price: 990,
    oldPrice: 1500
  });
});

test("WB extracts fallback product priceU", () => {
  assert.deepEqual(extractProductFallbackPrices({ priceU: 107700 }), {
    price: 1077,
    oldPrice: null
  });
});

test("WB includes results from second and third pages", async () => {
  const originalFetch = global.fetch;
  const requestedPages = [];

  global.fetch = async (url) => {
    const page = Number(new URL(String(url)).searchParams.get("page"));
    requestedPages.push(page);
    const offset = (page - 1) * 40;
    const products = Array.from({ length: 20 }, (_, index) => wbProduct(offset + index + 1, page));
    return responseJson({ data: { products } });
  };

  try {
    const items = await fetchWildberries("iphone 15 128gb", { timeoutMs: 12000 });

    assert.equal(requestedPages.includes(2), true);
    assert.equal(requestedPages.includes(3), true);
    assert.equal(items.some((item) => item.productId === "41"), true);
    assert.equal(items.some((item) => item.productId === "81"), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Yandex turns two JSON-LD offers into separate offers", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    sku: "model-1",
    name: "Apple iPhone 15 128GB",
    url: "https://market.yandex.ru/product/model-1",
    offers: [
      { price: 50000, url: "https://market.yandex.ru/offer/1", seller: { name: "Shop A" } },
      { price: 51000, url: "https://market.yandex.ru/offer/2", seller: { name: "Shop B" } }
    ]
  })}</script>`;

  const offers = parseJsonLdProducts(html);

  assert.equal(offers.length, 2);
  assert.deepEqual(offers.map((item) => item.price), [50000, 51000]);
  assert.deepEqual(offers.map((item) => item.url), ["https://market.yandex.ru/offer/1", "https://market.yandex.ru/offer/2"]);
});

test("Yandex does not combine one offer price with another offer URL", () => {
  const offer = normalizeYandexOffer({
    sku: "model-2",
    name: "Samsung Galaxy S24 Ultra 256GB",
    url: "https://market.yandex.ru/product/model-2"
  }, {
    price: 90000,
    url: "https://market.yandex.ru/offer/seller-a",
    seller: { name: "Seller A" }
  });

  assert.equal(offer.price, 90000);
  assert.equal(offer.url, "https://market.yandex.ru/offer/seller-a");
  assert.equal(offer.verified, true);
});

test("Yandex offer without offer.url is from-price and unverified", () => {
  const offer = normalizeYandexOffer({
    sku: "model-3",
    name: "Xiaomi Redmi Note 13 Pro",
    url: "https://market.yandex.ru/product/model-3"
  }, {
    price: 25000,
    seller: { name: "Seller A" }
  });

  assert.equal(offer.priceType, "from");
  assert.equal(offer.verified, false);
});

test("strict and relaxed filters are separate", () => {
  const items = [
    offer("wb", "1", "a", "Apple iPhone 15 128GB original", 60000),
    offer("wb", "2", "b", "iPhone 15 128GB", 59000),
    offer("wb", "3", "c", "Apple phone iPhone 15 128GB", 58000)
  ];
  const selected = selectRelevant("Apple iPhone 15 128GB original", items);

  assert.equal(selected.strictMatches >= 1, true);
  assert.equal(selected.items.some((item) => item.matchType === "possible"), true);
});

test("model, memory and modifiers remain required in relaxed mode", () => {
  const items = [
    offer("wb", "1", "a", "Apple iPhone 15 Pro 128GB", 50000),
    offer("wb", "2", "b", "Apple iPhone 15 256GB", 51000),
    offer("wb", "3", "c", "Apple iPhone 15 128GB", 52000)
  ];
  const selected = selectRelevant("iPhone 15 128GB", items);

  assert.deepEqual(selected.items.map((item) => item.title), ["Apple iPhone 15 128GB"]);
});

test("common search does not wait for Ozon", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes("search.wb.ru")) return responseJson({ data: { products: [] } });
    if (value.includes("market.yandex.ru")) return responseText("<html></html>");
    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const started = Date.now();
    const result = await searchMarketplaces("lavazza oro");
    const duration = Date.now() - started;

    assert.equal(result.marketplaces.ozon.status, "unavailable");
    assert.equal(duration < 15000, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("empty result is not cached for 10-15 minutes", () => {
  assert.equal(cacheTtlFor([
    { status: "empty", items: [] },
    { status: "empty", items: [] },
    { status: "unavailable", items: [] }
  ]), 0);
});

test("dedupe keys include variantId and offerId", () => {
  assert.notEqual(
    dedupeKey({ marketplace: "wb", productId: "1", variantId: "a" }),
    dedupeKey({ marketplace: "wb", productId: "1", variantId: "b" })
  );
  assert.notEqual(
    dedupeKey({ marketplace: "yandex", productId: "1", offerId: "a" }),
    dedupeKey({ marketplace: "yandex", productId: "1", offerId: "b" })
  );
});

test("Ozon Actor polling is controlled by a single deadline and does not use waitForFinish", async () => {
  const originalFetch = global.fetch;
  const requestedUrls = [];
  let runPolls = 0;

  global.fetch = async (url, options = {}) => {
    requestedUrls.push(String(url));
    const pathname = new URL(String(url)).pathname;

    if (pathname.includes("/acts/test~ozon/runs")) {
      assert.equal(options.method, "POST");
      assert.equal(String(url).includes("waitForFinish"), false);
      return responseJson({ data: { id: "run-1" } });
    }

    if (pathname.includes("/actor-runs/run-1")) {
      runPolls += 1;
      return responseJson({
        data: {
          id: "run-1",
          status: runPolls === 1 ? "RUNNING" : "SUCCEEDED",
          defaultDatasetId: "dataset-1"
        }
      });
    }

    if (pathname.includes("/datasets/dataset-1/items")) {
      return responseJson([{ product_id: "111", product_name: "Ozon item", current_price: 1000, product_url: "https://www.ozon.ru/product/111/", seller: "Shop" }]);
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const items = await runActor({
      actorId: "test/ozon",
      token: "token",
      timeoutMs: 65000,
      marketplace: "ozon",
      input: { queries: ["ssd"] }
    });

    assert.equal(items.length, 1);
    assert.equal(items._diagnostics.runStatus, "SUCCEEDED");
    assert.equal(requestedUrls.some((url) => url.includes("waitForFinish")), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Ozon normalizer recognizes snake_case fields", () => {
  const item = normalizeApifyProduct({
    product_id: "987654",
    offer_id: "offer-1",
    product_name: "SSD Samsung 2TB",
    current_price: "12 990",
    product_url: "https://www.ozon.ru/product/ssd-987654/",
    image_url: "https://example.test/image.webp",
    seller: "Ozon seller"
  }, "ozon");

  assert.equal(item.productId, "987654");
  assert.equal(item.offerId, "offer-1");
  assert.equal(item.title, "SSD Samsung 2TB");
  assert.equal(item.price, 12990);
  assert.equal(item.verified, true);
});

function offer(marketplace, productId, variantId, title, price) {
  return {
    marketplace,
    productId,
    offerId: variantId,
    variantId,
    title,
    variantName: "",
    price,
    oldPrice: null,
    priceType: "exact",
    seller: "seller",
    url: `https://example.test/${marketplace}/${productId}/${variantId}`,
    image: "",
    source: "test",
    matchType: "possible",
    verified: true,
    fetchedAt: new Date().toISOString()
  };
}
