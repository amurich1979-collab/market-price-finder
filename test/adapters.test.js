const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeApifyProduct, runActor } = require("../src/apify");
const { cacheTtlFor } = require("../src/search");
const {
  extractPrices,
  fetchWildberries,
  normalizeWildberriesProduct
} = require("../src/adapters/wildberries");

function responseJson(payload) {
  return {
    ok: true,
    json: async () => payload
  };
}

function wbProduct(id, priceU = 100000) {
  return {
    id,
    brand: "Apple",
    name: `iPhone 15 128GB ${id}`,
    sizes: [{ price: { total: priceU } }]
  };
}

test("WB gets products from the second page", async () => {
  const originalFetch = global.fetch;
  const requestedPages = [];

  global.fetch = async (url) => {
    const page = Number(new URL(String(url)).searchParams.get("page"));
    requestedPages.push(page);
    const offset = (page - 1) * 40;
    const products = Array.from({ length: 40 }, (_, index) => wbProduct(offset + index + 1));
    return responseJson({ data: { products } });
  };

  try {
    const items = await fetchWildberries("iphone 15 128gb", { timeoutMs: 5000 });

    assert.equal(requestedPages.includes(2), true);
    assert.equal(items.some((item) => item.productId === "41"), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("WB extracts the minimum price from sizes", () => {
  const product = {
    sizes: [
      { price: { total: 120000 } },
      { price: { final: 99000, basic: 150000 } }
    ]
  };

  assert.deepEqual(extractPrices(product), { price: 990, oldPrice: 1500 });
});

test("WB extracts fallback priceU fields", () => {
  const item = normalizeWildberriesProduct({
    id: 123,
    brand: "Lavazza",
    name: "Oro 1 kg",
    priceU: 107700
  });

  assert.equal(item.price, 1077);
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
      return responseJson([{ product_id: "111", product_name: "Ozon item", current_price: 1000 }]);
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

test("Ozon normalizer recognizes snake_case fields and builds product URL from id", () => {
  const item = normalizeApifyProduct({
    product_id: "987654",
    product_name: "SSD Samsung 2TB",
    current_price: "12 990",
    product_url: "",
    image_url: "https://example.test/image.webp"
  }, "ozon");

  assert.equal(item.productId, "987654");
  assert.equal(item.title, "SSD Samsung 2TB");
  assert.equal(item.price, 12990);
  assert.equal(item.url, "https://www.ozon.ru/product/987654/");
  assert.equal(item.image, "https://example.test/image.webp");
});

test("empty and failed results are not cached for 15 minutes", () => {
  assert.equal(cacheTtlFor([
    { status: "empty", items: [] },
    { status: "empty", items: [] },
    { status: "empty", items: [] }
  ]), 2 * 60 * 1000);

  assert.equal(cacheTtlFor([
    { status: "error", items: [] },
    { status: "error", items: [] },
    { status: "error", items: [] }
  ]), 0);
});
