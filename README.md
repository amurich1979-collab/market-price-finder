# Маркет-минимум

Локальное веб-приложение для сравнения цены товара на Ozon, Wildberries и Яндекс Маркете.

## Запуск

Сначала при необходимости создайте локальный `.env` из `.env.example` и заполните `APIFY_TOKEN`.
Файл `.env` подхватывается автоматически при старте сервера.

```powershell
npm start
```

После запуска откройте:

```text
http://localhost:5177
```

Не открывайте `index.html` или `lite.html` через `file://`: API поиска работает только через HTTP-сервер.
Старый адрес `/lite.html` теперь автоматически перенаправляет на актуальный интерфейс.

## Деплой на Render

Проект готов к деплою как Node Web Service.

Build command:

```text
npm install
```

Start command:

```text
npm start
```

В репозитории есть `render.yaml`, поэтому Render может создать сервис через Blueprint.

## Как работает

- Live-режим включен по умолчанию.
- Если задан `APIFY_TOKEN`, backend использует Apify actor как основной источник данных.
- Яндекс Маркет парсится из страницы поиска и обычно отдает настоящие цены.
- Wildberries проверяется через публичный каталог, а при 429 может использовать Apify fallback.
- Ozon не входит в быстрый `/api/search`: если отдельный проверенный источник не запущен, площадка возвращает `unavailable`.
- Для долгого Ozon-поиска есть отдельные endpoints: `POST /api/ozon/jobs` и `GET /api/ozon/jobs/:id`.
- Если задан `SGAI_API_KEY`, ScrapeGraphAI используется как основной источник для Ozon job и как fallback для Wildberries/Яндекс Маркета.
- История поиска хранится в браузере через `localStorage`.
- Подсказки строятся из найденных товарных названий и помогают уточнить запрос.
- Сравнение учитывает похожесть названия: товары с разными формулировками ранжируются по совпадению слов, артикулов и латинских/цифровых токенов.

У всех трех маркетплейсов стабильная автоматическая выдача цен требует официального seller/partner API, платного data API или собственного backend-парсера с учетом правил площадок и антибот-защиты.

## Apify

Для стабильного поиска через actor задайте переменные окружения:

```text
APIFY_TOKEN=...
APIFY_ACTOR_ID=isolovyev/ru-marketplaces-price-monitor
OZON_ACTOR_ID=isolovyev/ru-marketplaces-price-monitor
WB_ACTOR_ID=isolovyev/ru-marketplaces-price-monitor
OZON_TIMEOUT_MS=90000
WB_TIMEOUT_MS=20000
WB_ACTOR_TIMEOUT_MS=90000
APIFY_MAX_ITEMS=50
```

## ScrapeGraphAI

Для экспериментального Ozon-поиска через ScrapeGraphAI задайте:

```text
SGAI_API_KEY=...
SCRAPEGRAPH_ENDPOINT=https://v2-api.scrapegraphai.com/api/extract
SCRAPEGRAPH_COUNTRY=ru
SCRAPEGRAPH_STEALTH=true
```

Роли источника:

- Ozon: основной источник внутри `POST /api/ozon/jobs`;
- Wildberries: запасной источник, если публичный каталог и Apify fallback не вернули предложения;
- Яндекс Маркет: запасной источник, если JSON-LD страницы не дал предложений.

Результат показывается только если удалось связать цену, название и URL одного предложения. Для Ozon поисковые URL не принимаются как карточки товара.

Поддерживаемая схема результата actor'а:

```json
{
  "id": "3522815604",
  "title": "Стек GEPRC TAKER F722 BLS 60A V2 квадрокоптеров",
  "price": 20721,
  "url": "https://www.ozon.ru/product/...",
  "platform": "ozon",
  "query": "полетный контроллер f722",
  "currency": "RUB"
}
```

## API

Быстрый поиск:

```text
GET /api/search?q=iphone%2015%20128gb
```

Ozon запускается отдельно:

```text
POST /api/ozon/jobs
Content-Type: application/json

{"query":"iphone 15 128gb"}
```

Проверка job:

```text
GET /api/ozon/jobs/:id
```
