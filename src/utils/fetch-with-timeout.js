function providerTimeoutMs() {
  const value = parseInt(process.env.ENRICH_PROVIDER_TIMEOUT_MS || '8000', 10);
  return Number.isFinite(value) && value > 0 ? value : 8000;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = providerTimeoutMs()) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeout = new Error(`Request timed out after ${timeoutMs}ms`);
      timeout.name = 'TimeoutError';
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout, providerTimeoutMs };
