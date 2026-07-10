const ACCESSORY_WORDS = [
  "case",
  "cover",
  "glass",
  "screen protector",
  "protector",
  "film",
  "cable",
  "charger",
  "adapter",
  "strap",
  "bag",
  "filter",
  "brush",
  "battery",
  "чехол",
  "стекло",
  "пленка",
  "кабель",
  "зарядка",
  "адаптер",
  "ремешок",
  "сумка",
  "насадка",
  "фильтр",
  "щетка",
  "аккумулятор",
  "запчасть",
  "запчасти"
];

const ACCESSORY_QUERY_WORDS = [
  "case",
  "cover",
  "glass",
  "protector",
  "cable",
  "charger",
  "чехол",
  "стекло",
  "пленка",
  "кабель",
  "зарядка",
  "насадка",
  "фильтр"
];

const MODIFIERS = ["pro", "max", "plus", "ultra", "lite"];

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[,+/()_\-[\]{}|:;'"`~!?]+/g, " ")
    .replace(/\bгб\b/g, "gb")
    .replace(/\bгбайт\b/g, "gb")
    .replace(/\bтб\b/g, "tb")
    .replace(/\bтерабайт\b/g, "tb")
    .replace(/(\d+)\s+(gb|tb)\b/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/\\+"/g, '"')
    .replace(/\\+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parsePrice(value) {
  if (value == null) return null;
  const number = Number(String(value).replace(/[^\d.]/g, ""));
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function withTimeout(promiseFactory, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);

  return Promise.resolve()
    .then(() => promiseFactory(controller.signal))
    .finally(() => clearTimeout(timer));
}

function nowIso() {
  return new Date().toISOString();
}

function logDiagnostic(event, details) {
  const safe = { ...details };
  delete safe.token;
  delete safe.APIFY_TOKEN;
  console.log(JSON.stringify({ event, at: nowIso(), ...safe }));
}

function createEmptyMarketplace() {
  return { status: "error", message: "Источник не запускался.", items: [] };
}

module.exports = {
  ACCESSORY_QUERY_WORDS,
  ACCESSORY_WORDS,
  MODIFIERS,
  cleanTitle,
  createEmptyMarketplace,
  decodeHtml,
  logDiagnostic,
  normalizeText,
  nowIso,
  parsePrice,
  tokenize,
  uniqueBy,
  withTimeout
};
