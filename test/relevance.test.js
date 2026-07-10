const test = require("node:test");
const assert = require("node:assert/strict");
const { relevance, filterRelevant } = require("../src/relevance");

test("iPhone 15 128 GB rejects Pro, 256 GB and accessories", () => {
  assert.equal(relevance("iPhone 15 128 GB", "Apple iPhone 15 128GB black").ok, true);
  assert.equal(relevance("iPhone 15 128 GB", "Apple iPhone 15 Pro 128GB").ok, false);
  assert.equal(relevance("iPhone 15 128 GB", "Apple iPhone 15 256GB").ok, false);
  assert.equal(relevance("iPhone 15 128 GB", "Чехол для Apple iPhone 15 128GB").ok, false);
});

test("Samsung Galaxy S24 Ultra 256 requires Ultra and memory", () => {
  assert.equal(relevance("Samsung Galaxy S24 Ultra 256", "Samsung Galaxy S24 Ultra 256GB Titanium").ok, true);
  assert.equal(relevance("Samsung Galaxy S24 Ultra 256", "Samsung Galaxy S24 256GB").ok, false);
  assert.equal(relevance("Samsung Galaxy S24 Ultra 256", "Samsung Galaxy S24 Ultra 512GB").ok, false);
});

test("Dyson V8 matches main device and rejects accessories", () => {
  assert.equal(relevance("Dyson V8", "Пылесос Dyson V8 Absolute").ok, true);
  assert.equal(relevance("Dyson V8", "Фильтр для пылесоса Dyson V8").ok, false);
  assert.equal(relevance("Dyson V8", "Аккумулятор для Dyson V8").ok, false);
});

test("Xiaomi Redmi Note 13 Pro requires Pro modifier", () => {
  assert.equal(relevance("Xiaomi Redmi Note 13 Pro", "Xiaomi Redmi Note 13 Pro 8/256GB").ok, true);
  assert.equal(relevance("Xiaomi Redmi Note 13 Pro", "Xiaomi Redmi Note 13 8/256GB").ok, false);
});

test("different memory variants are filtered out", () => {
  assert.equal(relevance("iPhone 15 128GB", "iPhone 15 128GB").ok, true);
  assert.equal(relevance("iPhone 15 128GB", "iPhone 15 512GB").ok, false);
});

test("different Pro Max Ultra modifiers are filtered out", () => {
  assert.equal(relevance("iPhone 15 Pro Max 256GB", "iPhone 15 Pro Max 256GB").ok, true);
  assert.equal(relevance("iPhone 15 Pro Max 256GB", "iPhone 15 Pro 256GB").ok, false);
  assert.equal(relevance("Samsung S24 Ultra 256GB", "Samsung S24 Plus 256GB").ok, false);
});

test("filterRelevant keeps relevant items and sort by price can return cheapest first", () => {
  const items = [
    { title: "iPhone 15 256GB", price: 60000 },
    { title: "iPhone 15 128GB", price: 52000 },
    { title: "Чехол iPhone 15 128GB", price: 500 },
    { title: "Apple iPhone 15 128 GB", price: 51000 }
  ];
  const filtered = filterRelevant("iPhone 15 128GB", items).sort((a, b) => a.price - b.price);

  assert.deepEqual(filtered.map((item) => item.price), [51000, 52000]);
});
