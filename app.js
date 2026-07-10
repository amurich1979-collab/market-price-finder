const MARKETPLACES = {
  ozon: {
    name: "Ozon",
    searchUrl: (query) => `https://www.ozon.ru/search/?text=${encodeURIComponent(query)}`
  },
  wb: {
    name: "Wildberries",
    searchUrl: (query) => `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(query)}`
  },
  yandex: {
    name: "Яндекс Маркет",
    searchUrl: (query) => `https://market.yandex.ru/search?text=${encodeURIComponent(query)}`
  }
};

const demoCatalog = {
  "iphone 15 128gb": [
    { marketplace: "ozon", title: "Apple iPhone 15 128GB, черный", price: 74990, source: "demo", score: 100 },
    { marketplace: "wb", title: "Apple iPhone 15 128GB, черный", price: 73940, source: "demo", score: 100 },
    { marketplace: "yandex", title: "Apple iPhone 15 128GB, черный", price: 75490, source: "demo", score: 100 }
  ]
};

const state = {
  query: "полетный контроллер f722",
  results: [],
  statuses: [],
  suggestions: [],
  history: JSON.parse(localStorage.getItem("searchHistory") || "[]"),
  manual: JSON.parse(localStorage.getItem("manualPrices") || "[]")
};

const els = {
  form: document.querySelector("#searchForm"),
  query: document.querySelector("#query"),
  suggestions: document.querySelector("#suggestions"),
  demoMode: document.querySelector("#demoMode"),
  demoWarning: document.querySelector("#demoWarning"),
  status: document.querySelector("#status"),
  winner: document.querySelector("#winner"),
  cards: document.querySelector("#cards"),
  matches: document.querySelector("#matches"),
  template: document.querySelector("#marketCardTemplate"),
  manualForm: document.querySelector("#manualForm"),
  manualMarketplace: document.querySelector("#manualMarketplace"),
  manualTitle: document.querySelector("#manualTitle"),
  manualPrice: document.querySelector("#manualPrice"),
  clearManual: document.querySelector("#clearManual"),
  historyList: document.querySelector("#historyList")
};

let suggestTimer = null;

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = els.query.value.trim();
  if (!query) return;
  await search(query);
});

els.query.addEventListener("input", () => {
  window.clearTimeout(suggestTimer);
  suggestTimer = window.setTimeout(() => loadSuggestions(els.query.value.trim()), 260);
});

els.manualForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const price = parsePrice(els.manualPrice.value);
  if (!price) {
    els.manualPrice.focus();
    return;
  }

  state.manual.push({
    marketplace: els.manualMarketplace.value,
    title: els.manualTitle.value.trim() || state.query,
    query: state.query,
    price,
    score: 100,
    source: "manual"
  });
  localStorage.setItem("manualPrices", JSON.stringify(state.manual));
  els.manualTitle.value = "";
  els.manualPrice.value = "";
  render();
});

els.clearManual.addEventListener("click", () => {
  state.manual = [];
  localStorage.removeItem("manualPrices");
  render();
});

els.demoMode.addEventListener("change", () => {
  search(state.query);
});

async function search(query) {
  state.query = query;
  els.query.value = query;
  rememberSearch(query);
  els.status.textContent = els.demoMode.checked ? "Готовлю тестовые цены..." : "Ищу реальные цены на площадках...";
  els.winner.hidden = true;
  state.results = [];
  state.statuses = [];
  renderSkeleton(query);

  if (els.demoMode.checked) {
    state.results = getDemoResults(query);
    state.statuses = Object.keys(MARKETPLACES).map((marketplace) => ({
      marketplace,
      ok: true,
      message: "Тестовый источник."
    }));
    state.suggestions = state.results.map((item) => ({ text: item.title, marketplace: item.marketplace, price: item.price, score: item.score }));
    els.status.textContent = "Демо-режим: показаны тестовые цены, не реальные найденные минимумы.";
    render();
    return;
  }

  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const payload = await response.json();
    state.results = payload.results || [];
    state.statuses = payload.statuses || [];
    state.suggestions = payload.suggestions || [];
    els.status.textContent = payload.note || "Готово.";
    fillSuggestionOptions(state.suggestions);
  } catch {
    els.status.textContent = "Не удалось обратиться к локальному API. Проверьте, что server.js запущен.";
  }
  render();
}

async function loadSuggestions(query) {
  if (query.length < 2 || els.demoMode.checked) return;

  try {
    const response = await fetch(`/api/suggest?q=${encodeURIComponent(query)}`);
    const payload = await response.json();
    fillSuggestionOptions(payload.suggestions || []);
  } catch {
    // Suggestions are helpful, not critical.
  }
}

function fillSuggestionOptions(suggestions) {
  els.suggestions.replaceChildren(
    ...suggestions.map((item) => {
      const option = document.createElement("option");
      option.value = item.text;
      option.label = item.price ? `${MARKETPLACES[item.marketplace]?.name || "найдено"} · ${formatRub(item.price)}` : "найдено";
      return option;
    })
  );
}

function getDemoResults(query) {
  const key = query.toLowerCase();
  return demoCatalog[key] || [
    { marketplace: "ozon", title: `${query} · найдено на Ozon`, price: 12990, source: "demo", score: 92 },
    { marketplace: "wb", title: `${query} · найдено на Wildberries`, price: 12470, source: "demo", score: 95 },
    { marketplace: "yandex", title: `${query} · найдено на Яндекс Маркете`, price: 13180, source: "demo", score: 90 }
  ];
}

function renderSkeleton(query) {
  els.cards.replaceChildren(
    ...Object.keys(MARKETPLACES).map((marketplace) => createCard({
      marketplace,
      title: `Поиск: ${query}`,
      price: null,
      score: null,
      source: "loading"
    }))
  );
  els.matches.replaceChildren();
}

function render() {
  const merged = mergeResults(state.results, state.manual);
  const bestByMarket = Object.keys(MARKETPLACES).map((marketplace) => {
    return bestCandidate(merged, marketplace) || {
      marketplace,
      title: "Цена пока не получена",
      price: null,
      score: null,
      source: "empty",
      status: statusFor(marketplace)
    };
  });
  const comparable = merged.filter((item) => item.price && (item.score ?? 0) >= 35);
  const winner = (comparable.length ? comparable : merged.filter((item) => item.price)).sort((a, b) => a.price - b.price)[0];

  els.demoWarning.hidden = !els.demoMode.checked;
  els.winner.hidden = !winner;
  if (winner) {
    els.winner.textContent = `Самая низкая подходящая цена: ${formatRub(winner.price)} — ${MARKETPLACES[winner.marketplace].name}. Похожесть: ${winner.score ?? "?"}%.`;
  }

  els.cards.replaceChildren(...bestByMarket.map((item) => createCard(item, winner)));
  renderMatches(merged, winner);
  renderHistory();
}

function bestCandidate(items, marketplace) {
  const candidates = items.filter((item) => item.marketplace === marketplace && item.price);
  const confident = candidates.filter((item) => (item.score ?? 0) >= 35);
  return (confident.length ? confident : candidates).sort((a, b) => a.price - b.price)[0] || null;
}

function createCard(item, winner) {
  const node = els.template.content.firstElementChild.cloneNode(true);
  const market = MARKETPLACES[item.marketplace];
  const isWinner = Boolean(winner && item.price === winner.price && item.marketplace === winner.marketplace && item.title === winner.title);
  node.classList.toggle("best", isWinner);
  node.querySelector(".market-name").textContent = market.name;
  node.querySelector(".item-title").textContent = item.title;
  node.querySelector(".badge").textContent = sourceLabel(item.source);
  node.querySelector(".price").textContent = item.price ? formatRub(item.price) : "Нет цены";
  node.querySelector(".meta").textContent = metaText(item);
  node.querySelector(".open-link").href = item.url || market.searchUrl(state.query);
  node.querySelector(".report-lower").addEventListener("click", () => startManualOverride(item));
  return node;
}

function renderMatches(items, winner) {
  const sorted = [...items].filter((item) => item.price).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.price - b.price).slice(0, 12);

  if (!sorted.length) {
    els.matches.innerHTML = `<h2>Совпадения</h2><p class="muted">Пока нет реальных цен. Уточните запрос или откройте поиск на площадках.</p>`;
    return;
  }

  els.matches.innerHTML = `<h2>Найденные варианты</h2>`;
  const list = document.createElement("div");
  list.className = "match-list";

  for (const item of sorted) {
    const row = document.createElement("article");
    row.className = "match-row";
    row.classList.toggle("best", Boolean(winner && item.title === winner.title && item.marketplace === winner.marketplace && item.price === winner.price));
    row.innerHTML = `
      <div>
        <p class="market-name">${MARKETPLACES[item.marketplace].name} · ${sourceLabel(item.source)} · похожесть ${item.score ?? "?"}%</p>
        <h3>${escapeHtml(item.title)}</h3>
      </div>
      <strong>${formatRub(item.price)}</strong>
      <a class="open-link" target="_blank" rel="noreferrer" href="${item.url || MARKETPLACES[item.marketplace].searchUrl(state.query)}">Открыть</a>
    `;
    list.appendChild(row);
  }

  els.matches.appendChild(list);
}

function mergeResults(results, manual) {
  const currentQuery = state.query.toLowerCase();
  const relevantManual = manual.filter((item) => {
    if (item.query) return item.query.toLowerCase() === currentQuery;
    return item.title.toLowerCase().includes(currentQuery);
  });
  return [...results, ...relevantManual].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.price - b.price);
}

function statusFor(marketplace) {
  return state.statuses.find((item) => item.marketplace === marketplace)?.message || "";
}

function startManualOverride(item) {
  els.manualMarketplace.value = item.marketplace;
  els.manualTitle.value = item.title && item.title !== "Цена пока не получена" ? item.title : state.query;
  els.manualPrice.value = item.price ? String(Math.max(item.price - 1, 1)) : "";
  els.manualPrice.focus();
  document.querySelector(".manual-panel").scrollIntoView({ behavior: "smooth", block: "center" });
}

function rememberSearch(query) {
  const normalized = query.trim();
  state.history = [normalized, ...state.history.filter((item) => item.toLowerCase() !== normalized.toLowerCase())].slice(0, 10);
  localStorage.setItem("searchHistory", JSON.stringify(state.history));
  renderHistory();
}

function renderHistory() {
  els.historyList.replaceChildren(
    ...state.history.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "history-chip";
      button.textContent = item;
      button.addEventListener("click", () => search(item));
      return button;
    })
  );
}

function parsePrice(value) {
  const number = Number(String(value).replace(/[^\d]/g, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatRub(value) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(value);
}

function sourceLabel(source) {
  return {
    demo: "демо",
    apify: "apify",
    live: "live",
    manual: "вручную",
    loading: "поиск",
    empty: "нет"
  }[source] || source;
}

function metaText(item) {
  if (item.source === "apify") return `Данные Apify. Похожесть с запросом: ${item.score ?? "?"}%.`;
  if (item.source === "live") return `Живая цена. Похожесть с запросом: ${item.score ?? "?"}%.`;
  if (item.source === "manual") return "Цена добавлена вручную и участвует в сравнении.";
  if (item.source === "demo") return "Тестовая цена. Если нашли дешевле, укажите цену ниже.";
  if (item.source === "loading") return "Проверяю источник.";
  return item.status || "Источник не отдал цену автоматически.";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

renderHistory();
search(state.query);
