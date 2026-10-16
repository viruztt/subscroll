// Small fetch wrapper. In the app, main.js swaps in Electron's net.fetch so
// requests use the system proxy and certificates; tests swap in a fake.
let fetchImpl = (...args) => globalThis.fetch(...args);

function setFetch(fn) {
  fetchImpl = fn;
}

async function getJson(url, { timeoutMs = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Run fn over items with at most `limit` in flight.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = { setFetch, getJson, mapLimit, chunk };
