const { fetchOzon } = require("./adapters/ozon");
const { nowIso } = require("./utils");

const jobs = new Map();

function createOzonJob(query) {
  const normalized = String(query || "").trim();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    query: normalized,
    status: "running",
    message: "Поиск Ozon запущен",
    items: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  jobs.set(id, job);

  runOzonJob(job);
  return job;
}

function getOzonJob(id) {
  return jobs.get(id) || null;
}

async function runOzonJob(job) {
  try {
    const items = await fetchOzon(job.query);
    job.status = items.length ? "ok" : "empty";
    job.message = items.length ? `Найдено ${items.length} предложений Ozon` : "Ozon не вернул проверенные предложения";
    job.items = items.slice(0, 3);
  } catch (error) {
    job.status = "error";
    job.message = error.message || "Источник Ozon не ответил";
    job.items = [];
  } finally {
    job.updatedAt = nowIso();
  }
}

module.exports = {
  createOzonJob,
  getOzonJob
};
