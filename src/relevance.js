const {
  ACCESSORY_QUERY_WORDS,
  ACCESSORY_WORDS,
  MODIFIERS,
  normalizeText,
  tokenize
} = require("./utils");

const STOPWORDS = new Set([
  "для",
  "and",
  "the",
  "with",
  "без",
  "на",
  "в",
  "с",
  "из",
  "по",
  "купить",
  "оригинал",
  "новый",
  "black",
  "white",
  "черный",
  "белый"
]);

function relevance(query, product, options = {}) {
  const minTokenOverlap = options.minTokenOverlap || 0.72;
  const title = typeof product === "string" ? product : product?.title;
  const queryNorm = normalizeText(query);
  const titleNorm = normalizeText(title);
  const queryTokens = importantTokens(queryNorm);
  const titleTokens = importantTokens(titleNorm);

  if (!queryTokens.length || !titleTokens.length) {
    return { ok: false, score: 0, reason: "empty_tokens" };
  }

  const accessoryCheck = checkAccessories(queryNorm, titleNorm);
  if (!accessoryCheck.ok) return accessoryCheck;

  const modelCheck = checkModelsAndNumbers(queryTokens, titleTokens);
  if (!modelCheck.ok) return modelCheck;

  const memoryCheck = checkMemory(queryNorm, titleNorm);
  if (!memoryCheck.ok) return memoryCheck;

  const modifierCheck = checkModifiers(queryTokens, titleTokens);
  if (!modifierCheck.ok) return modifierCheck;

  const overlap = tokenOverlap(queryTokens, titleTokens);
  if (overlap < minTokenOverlap) {
    return { ok: false, score: Math.round(overlap * 100), reason: "low_token_overlap" };
  }

  return { ok: true, score: Math.round(overlap * 100), reason: "matched" };
}

function filterRelevant(query, items, options = {}) {
  return items
    .map((item) => {
      const result = relevance(query, item, options);
      return { ...item, relevance: result };
    })
    .filter((item) => item.relevance.ok);
}

function importantTokens(value) {
  return tokenize(value).filter((token) => !STOPWORDS.has(token));
}

function tokenOverlap(queryTokens, titleTokens) {
  let matched = 0;

  for (const token of queryTokens) {
    if (titleTokens.some((candidate) => tokensMatch(token, candidate))) {
      matched += 1;
    }
  }

  return matched / queryTokens.length;
}

function tokensMatch(queryToken, titleToken) {
  if (queryToken === titleToken) return true;
  if (/^\d+$/.test(queryToken) && titleToken.startsWith(queryToken)) return true;
  if (/^\d+(?:gb|tb)$/.test(queryToken) && titleToken === queryToken.replace(/(gb|tb)$/, "")) return true;
  if (/^\d+(?:gb|tb)$/.test(titleToken) && queryToken === titleToken.replace(/(gb|tb)$/, "")) return true;
  if (queryToken.length >= 4 && titleToken.includes(queryToken)) return true;
  if (titleToken.length >= 4 && queryToken.includes(titleToken)) return true;
  return false;
}

function checkAccessories(queryNorm, titleNorm) {
  const queryIsAccessory = ACCESSORY_QUERY_WORDS.some((word) => queryNorm.includes(word));
  const titleIsAccessory = ACCESSORY_WORDS.some((word) => titleNorm.includes(word));

  if (!queryIsAccessory && titleIsAccessory) {
    return { ok: false, score: 0, reason: "accessory_for_main_device_query" };
  }

  return { ok: true };
}

function checkModelsAndNumbers(queryTokens, titleTokens) {
  const required = queryTokens.filter(isModelToken);

  for (const token of required) {
    if (!titleTokens.some((candidate) => tokensMatch(token, candidate))) {
      return { ok: false, score: 0, reason: `missing_model_or_number:${token}` };
    }
  }

  return { ok: true };
}

function isModelToken(token) {
  if (MODIFIERS.includes(token)) return false;
  if (/^\d+$/.test(token)) return true;
  return /[a-zа-я]/i.test(token) && /\d/.test(token);
}

function checkMemory(queryNorm, titleNorm) {
  const queryMemories = extractMemory(queryNorm);
  const titleMemories = extractMemory(titleNorm);

  if (!queryMemories.length) return { ok: true };
  if (!queryMemories.some((memory) => titleMemories.includes(memory))) {
    return { ok: false, score: 0, reason: "missing_required_memory" };
  }

  const conflicting = titleMemories.some((memory) => !queryMemories.includes(memory));
  if (conflicting) {
    return { ok: false, score: 0, reason: "conflicting_memory" };
  }

  return { ok: true };
}

function extractMemory(value) {
  const normalized = normalizeText(value).replace(/(\d+)\s*(gb|tb)\b/g, "$1$2");
  const matches = normalized.match(/\b\d+(?:gb|tb)\b/g);
  return matches ? [...new Set(matches)] : [];
}

function checkModifiers(queryTokens, titleTokens) {
  const queryMods = MODIFIERS.filter((mod) => queryTokens.includes(mod));
  const titleMods = MODIFIERS.filter((mod) => titleTokens.includes(mod));

  for (const mod of queryMods) {
    if (!titleMods.includes(mod)) {
      return { ok: false, score: 0, reason: `missing_modifier:${mod}` };
    }
  }

  const unexpected = titleMods.find((mod) => !queryMods.includes(mod));
  if (unexpected) {
    return { ok: false, score: 0, reason: `unexpected_modifier:${unexpected}` };
  }

  return { ok: true };
}

module.exports = {
  extractMemory,
  filterRelevant,
  relevance,
  tokenOverlap
};
