// server/proxy.js
// Simple outbound proxy router with FIFO queue (concurrency 1) and lightweight retry on 429.
// This implementation expects these env vars when used:
//  - MAIN_API_BASE_URL
//  - MAIN_API_KEY
// It intentionally strips browser-sent headers and only sends minimal server->server headers.

const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');

const MAIN_API_BASE = process.env.MAIN_API_BASE_URL;
const MAIN_API_KEY = process.env.MAIN_API_KEY;

if (!MAIN_API_BASE) {
  console.warn('[proxy] MAIN_API_BASE_URL not set; proxy will still mount but calls will error until configured');
}
if (!MAIN_API_KEY) {
  console.warn('[proxy] MAIN_API_KEY not set; proxy will still mount but calls will error until configured');
}

function buildUpstreamUrl(req, upstreamPath) {
  const base = new URL(upstreamPath, MAIN_API_BASE || 'http://127.0.0.1/');
  const idx = req.url.indexOf('?');
  if (idx !== -1) {
    base.search = req.url.slice(idx + 1);
  }
  return base.toString();
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetryLite(url, opts, retryOpts = {}) {
  const maxAttempts = Number(retryOpts.maxAttempts || 2);
  const baseMs = Number(retryOpts.baseMs || 300);
  const maxTotalWaitMs = Number(retryOpts.maxTotalWaitMs || 3000);

  let cumulativeWait = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      throw err;
    }

    if (res.status !== 429) return res;

    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) {
      const asInt = parseInt(retryAfter, 10);
      if (!Number.isNaN(asInt)) {
        const requestedMs = asInt * 1000;
        if (requestedMs > maxTotalWaitMs || attempt === maxAttempts) {
          return res;
        }
        const wait = Math.min(requestedMs, maxTotalWaitMs - cumulativeWait);
        cumulativeWait += wait;
        console.warn(`[proxy] upstream 429 - honoring Retry-After ${asInt}s, waiting ${wait}ms (attempt ${attempt})`);
        await delay(wait);
        continue;
      } else {
        const dateMs = Date.parse(retryAfter);
        if (!Number.isNaN(dateMs)) {
          const wait = Math.max(0, Math.min(maxTotalWaitMs - cumulativeWait, dateMs - Date.now()));
          if (wait <= 0 || attempt === maxAttempts) return res;
          cumulativeWait += wait;
          console.warn(`[proxy] upstream 429 - Retry-After date, waiting ${wait}ms (attempt ${attempt})`);
          await delay(wait);
          continue;
        }
      }
    }

    const jitter = Math.random() * baseMs;
    const backoff = Math.min(maxTotalWaitMs - cumulativeWait, baseMs * 2 ** (attempt - 1) + jitter);
    if (backoff <= 0 || attempt === maxAttempts) return res;
    cumulativeWait += backoff;
    console.warn(`[proxy] upstream 429 - backoff ${backoff}ms (attempt ${attempt})`);
    await delay(backoff);
  }

  return await fetch(url, opts);
}

// Simple FIFO queue (concurrency 1)
class RequestQueue {
  constructor() {
    this.queue = [];
    this.running = false;
    this.shutdown = false;
  }
  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this._startIfNeeded();
    });
  }
  async _startIfNeeded() {
    if (this.running || this.shutdown) return;
    this.running = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      try {
        const result = await item.task();
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }
    this.running = false;
  }
  async stop({ flush = true } = {}) {
    this.shutdown = true;
    if (!flush) {
      while (this.queue.length > 0) {
        const it = this.queue.shift();
        it.reject(new Error('Server shutting down, request rejected'));
      }
    } else {
      while (this.running || this.queue.length > 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
}

const queue = new RequestQueue();

function createRouter() {
  const router = express.Router();

  // Preflight handler for proxy (should be very fast)
  router.options('/*', (req, res) => res.sendStatus(204));

  router.use(async (req, res) => {
    try {
      const upstreamPath = req.originalUrl.replace(/^\/proxy/, '') || '/';
      const upstreamUrl = buildUpstreamUrl(req, upstreamPath);

      // Minimal headers: preserve Bearer if present, otherwise use ApiKey
      const headers = {};
      const clientAuth = (req.get('authorization') || '').trim();
      if (clientAuth && clientAuth.toLowerCase().startsWith('bearer ')) {
        headers['authorization'] = clientAuth;
      } else if (MAIN_API_KEY) {
        headers['authorization'] = `ApiKey ${MAIN_API_KEY}`;
      }

      if (MAIN_API_KEY) headers['x-api-key'] = MAIN_API_KEY;
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.is('application/json')) {
        headers['content-type'] = 'application/json';
      }

      const opts = { method: req.method, headers, redirect: 'follow' };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.is('application/json')) opts.body = JSON.stringify(req.body || {});
        else opts.body = req.body;
      }

      console.log('[proxy] enqueue ->', req.method, req.originalUrl, '->', upstreamUrl);

      const upstreamRes = await queue.enqueue(async () => {
        return await fetchWithRetryLite(upstreamUrl, opts, { maxAttempts: 2, baseMs: 300, maxTotalWaitMs: 3000 });
      });

      const upstreamText = await upstreamRes.text().catch(() => null);
      const preview = typeof upstreamText === 'string' ? upstreamText.slice(0, 1000) : '<binary>';
      console.log('[proxy] upstream status:', upstreamRes.status, 'preview:', preview);

      // If 429, forward Retry-After header/body
      const retryAfter = upstreamRes.headers.get('retry-after');
      if (upstreamRes.status === 429) {
        if (retryAfter) res.setHeader('Retry-After', retryAfter);
        const body = upstreamText || JSON.stringify({ error: 'Too Many Requests', retryAfter: retryAfter || null });
        return res.status(429).send(body);
      }

      res.status(upstreamRes.status);
      upstreamRes.headers.forEach((value, name) => {
        const lower = name.toLowerCase();
        if (['set-cookie', 'transfer-encoding', 'connection', 'content-encoding', 'content-length'].includes(lower)) return;
        res.setHeader(name, value);
      });

      return res.send(upstreamText);
    } catch (err) {
      console.error('[proxy] error', err && err.stack ? err.stack : err);
      return res.status(502).json({ error: 'Bad gateway' });
    }
  });

  // expose stop for graceful shutdown if needed
  router._stopQueue = async () => {
    try {
      await queue.stop({ flush: true });
    } catch (e) { /* ignore */ }
  };

  return router;
}

module.exports = createRouter;
