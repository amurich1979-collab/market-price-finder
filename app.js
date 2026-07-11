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

const state = {
  query: "lavazza oro",
  response: null,
  history: JSON.parse(localStorage.getItem("searchHistory") || "[]")
};

const els = {
  form: document.querySelector("#searchForm"),
  query: document.querySelector("#query"),
  suggestions: document.querySelector("#suggestions"),
  status: document.querySelector("#status"),
  cards: document.querySelector("#cards"),
  matches: document.querySelector("#matches"),
  historyList: document.querySelector("#historyList"),
  demoMode: document.querySelector("#demoMode"),
  demoWarning: document.querySelector("#demoWarning"),
  clearManual: document.querySelector("#clearManual"),
  manualForm: document.querySelector("#manualForm")
};

els.demoMode.closest(".switch").hidden = true;
els.clearManual.hidden = true;
els.manualForm.closest(".manual-panel").hidden = true;
els.demoWarning.hidden = true;

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = els.query.value.trim();
  if (!query) return;
  await search(query);
});

els.query.addEventListener("input", () => {
  fillHistorySuggestions(els.query.value.trim());
});

els.query.addEventListener("focus", () => {
  fillHistorySuggestions(els.query.value.trim());
});

async function search(query) {
  state.query = query;
  els.query.value = query;
  rememberSearch(query);
  els.status.textContent = "Ищу товары на Ozon, Wildberries и Яндекс Маркете...";
  renderSkeleton();

  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const payload = await response.json();
    state.response = payload;
    els.status.textContent = statusText(payload);
    render(payload);
  } catch {
    els.status.textContent = "Не удалось обратиться к API поиска.";
  }
}

function renderSkeleton() {
  els.cards.replaceChildren(
    ...Object.keys(MARKETPLACES).map((marketplace) => createSection(marketplace, {
      status: "loading",
      message: "Проверяю источник...",
      items: []
    }))
  );
  els.matches.replaceChildren();
}

function render(payload) {
  els.cards.replaceChildren(
    ...Object.keys(MARKETPLACES).map((marketplace) => createSection(marketplace, payload.marketplaces?.[marketplace]))
  );
  renderHistory();
}

function createSection(marketplace, result = { status: "error", message: "Нет данных.", items: [] }) {
  const section = document.createElement("section");
  section.className = "market-section";
  section.innerHTML = `
    <div class="market-section-head">
      <div>
        <p class="market-name">${MARKETPLACES[marketplace].name}</p>
        <h2>${sectionTitle(result)}</h2>
      </div>
      <span class="badge">${result.status}</span>
    </div>
    <p class="meta">${escapeHtml(result.message || "")}</p>
  `;

  const list = document.createElement("div");
  list.className = "product-list";

  if (result.items?.length) {
    result.items.forEach((item) => list.appendChild(createProductCard(item)));
  } else {
    const empty = document.createElement("article");
    empty.className = "product-card empty";
    empty.innerHTML = `
      <h3>Товары не найдены</h3>
      <p class="meta">Попробуйте уточнить запрос или открыть поиск на площадке.</p>
      <a class="open-link" target="_blank" rel="noreferrer" href="${MARKETPLACES[marketplace].searchUrl(state.query)}">Открыть поиск</a>
    `;
    list.appendChild(empty);
  }

  section.appendChild(list);
  return section;
}

function createProductCard(item) {
  const card = document.createElement("article");
  card.className = "product-card";
  card.innerHTML = `
    ${item.image ? `<img class="product-image" src="${escapeHtml(item.image)}" alt="">` : ""}
    <h3>${escapeHtml(item.title)}</h3>
    <p class="price">${formatRub(item.price)}</p>
    ${item.oldPrice && item.oldPrice > item.price ? `<p class="old-price">${formatRub(item.oldPrice)}</p>` : ""}
    <p class="meta">${escapeHtml([item.seller, item.source, item.relevanceScore ? `релевантность ${item.relevanceScore}%` : ""].filter(Boolean).join(" · "))}</p>
    <a class="open-link" target="_blank" rel="noreferrer" href="${escapeHtml(item.url)}">Открыть товар</a>
  `;
  return card;
}

function sectionTitle(result) {
  if (result.status === "ok") return "Самые дешевые релевантные";
  if (result.status === "empty") return "Нет релевантных товаров";
  if (result.status === "loading") return "Поиск";
  return "Источник недоступен";
}

function statusText(payload) {
  const parts = Object.entries(payload.marketplaces || {}).map(([key, value]) => {
    const count = value.items?.length || 0;
    return `${MARKETPLACES[key].name}: ${count}`;
  });
  return `Готово. ${parts.join(" · ")}`;
}

function rememberSearch(query) {
  const normalized = query.trim();
  state.history = [normalized, ...state.history.filter((item) => item.toLowerCase() !== normalized.toLowerCase())].slice(0, 30);
  localStorage.setItem("searchHistory", JSON.stringify(state.history));
  renderHistory();
  fillHistorySuggestions(normalized);
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

function fillHistorySuggestions(query = "") {
  const normalized = query.toLowerCase();
  const options = state.history
    .filter((item) => !normalized || item.toLowerCase().includes(normalized))
    .slice(0, 12)
    .map((item) => {
      const option = document.createElement("option");
      option.value = item;
      option.label = "история";
      return option;
    });
  els.suggestions.replaceChildren(...options);
}

function formatRub(value) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(value);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

renderHistory();
fillHistorySuggestions();
search(state.query);
