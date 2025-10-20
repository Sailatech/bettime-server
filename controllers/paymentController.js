// controllers/paymentController.js
// Self-contained Paystack controller. Resolves placeholder {reference} by looking up
// the most recent pending deposit for the authenticated user and then verifies/finalizes it.

const crypto = require('crypto');
const { URL } = require('url');
const { getPool } = require('../config/db');
const { findToken } = require('../helpers/tokenHelper');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET || process.env.PAYSTACK_SECRET_KEY || '';
const FRONTEND_CALLBACK_URL = process.env.FRONTEND_CALLBACK_URL || null;
const PAYSTACK_TIMEOUT_MS = Number(process.env.PAYSTACK_REQUEST_TIMEOUT_MS || 15000);

function toKobo(amountNaira) {
  return Math.round(Number(amountNaira) * 100);
}

/* ---------- minimal fetch helper ---------- */
let _fetch = null;
let _AbortController = null;
function resolveFetch() {
  if (_fetch) return;
  if (typeof globalThis.fetch === 'function') {
    _fetch = globalThis.fetch.bind(globalThis);
    _AbortController = globalThis.AbortController;
    return;
  }
  try {
    const undici = require('undici');
    if (typeof undici.fetch === 'function') {
      _fetch = undici.fetch;
      _AbortController = undici.AbortController || globalThis.AbortController;
      return;
    }
  } catch (e) {}
  try {
    const nodeFetch = require('node-fetch');
    _fetch = nodeFetch.default || nodeFetch;
    _AbortController = nodeFetch.AbortController || globalThis.AbortController;
    return;
  } catch (e) {}
  throw new Error('No fetch implementation available. Use Node 18+, undici, or node-fetch.');
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = PAYSTACK_TIMEOUT_MS) {
  resolveFetch();
  const controller = _AbortController ? new _AbortController() : null;
  const finalOpts = controller ? Object.assign({}, opts, { signal: controller.signal }) : opts;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await _fetch(url, finalOpts);
    if (timer) clearTimeout(timer);
    return res;
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      const e = new Error('Request timed out');
      e.code = 'ETIMEDOUT';
      throw e;
    }
    throw err;
  }
}

/* ---------- Inline Paystack API functions ---------- */
function buildPaystackHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (PAYSTACK_SECRET) headers.Authorization = `Bearer ${PAYSTACK_SECRET}`;
  return headers;
}

async function initializeTransaction({ email, amountKobo, reference, callback_url }) {
  resolveFetch();
  const url = 'https://api.paystack.co/transaction/initialize';
  const body = { email, amount: amountKobo, reference };
  if (callback_url) body.callback_url = callback_url;
  const opts = { method: 'POST', headers: buildPaystackHeaders(), body: JSON.stringify(body) };

  const resp = await fetchWithTimeout(url, opts);
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (e) { throw Object.assign(new Error('Paystack initialize returned non-JSON'), { raw: text, status: resp.status }); }
  if (!resp.ok) {
    throw Object.assign(new Error('Paystack initialize failed'), { raw: data, status: resp.status });
  }
  return data;
}

async function verifyTransaction(reference) {
  resolveFetch();
  const url = `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`;
  const opts = { method: 'GET', headers: buildPaystackHeaders() };

  const resp = await fetchWithTimeout(url, opts);
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (e) { throw Object.assign(new Error('Paystack verify returned non-JSON'), { raw: text, status: resp.status }); }
  if (!resp.ok) {
    // propagate Paystack API error object where possible
    const err = new Error('Paystack verify failed');
    err.raw = data;
    err.status = resp.status;
    throw err;
  }
  return data;
}

/* ---------- token population ---------- */
async function populateUserFromHeader(req) {
  if (req.user && req.user.id) return;
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || null;
  let token = null;
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) token = authHeader.slice(7).trim();
  else if (req.cookies && req.cookies.xo_token) token = req.cookies.xo_token;
  if (!token) {
    console.info('[auth] no token provided (header or cookie)');
    return;
  }
  try {
    const tokenRow = await findToken(token, { requireActive: true });
    if (!tokenRow) return;
    req.user = { id: tokenRow.user_id || tokenRow.id || tokenRow.userId, username: tokenRow.username, email: tokenRow.email, balance: Number(tokenRow.balance ?? 0), status: tokenRow.status || 'active' };
    req.authToken = { token, tokenId: tokenRow.token_id, expiresAt: tokenRow.expires_at };
  } catch (e) {
    console.warn('[paymentController] token lookup failed', e && e.message);
  }
}

/* ---------- reference validation ---------- */
function normalizeAndValidateReference(raw) {
  if (!raw && raw !== 0) return null;
  const ref = String(raw).trim();
  if (!ref) return null;
  const placeholders = ['{reference}', '<reference>', 'REFERENCE', 'reference'];
  if (placeholders.includes(ref)) return null;
  if (ref.startsWith('${') && ref.endsWith('}')) return null;
  if (ref.includes('{') || ref.includes('}') || ref.includes(' ')) return null;
  return ref;
}

/* ---------- schema detection ---------- */
let _schemaDetected = null;
async function detectSchema() {
  if (_schemaDetected !== null) return _schemaDetected;
  try {
    const pool = await getPool();
    const dbName = (pool && pool.config && pool.config.connectionConfig && pool.config.connectionConfig.database) || process.env.DB_NAME;
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'balance_transactions' AND COLUMN_NAME IN ('status','meta')`,
      [dbName]
    );
    const cols = (rows || []).map(r => r.COLUMN_NAME);
    _schemaDetected = { hasStatus: cols.includes('status'), hasMeta: cols.includes('meta') };
  } catch (e) {
    _schemaDetected = { hasStatus: false, hasMeta: false };
  }
  return _schemaDetected;
}

/* ---------- finalizeDeposit idempotent ---------- */
async function finalizeDeposit(reference, paystackData) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const schema = await detectSchema();

    const [rows] = await conn.query(`SELECT * FROM balance_transactions WHERE reference_id = ? LIMIT 1 FOR UPDATE`, [reference]);
    const record = rows && rows[0];

    // idempotency
    if (schema.hasStatus) {
      if (record && (String(record.status).toLowerCase() === 'successful' || String(record.status).toLowerCase() === 'completed' || String(record.status).toLowerCase() === 'success')) {
        await conn.commit();
        conn.release();
        return { ok: true, alreadyProcessed: true, amount: record.amount };
      }
    } else {
      const [creditRows] = await conn.query(`SELECT id FROM balance_transactions WHERE reference_id = ? AND type = 'credit' AND source = 'deposit' LIMIT 1`, [reference]);
      if (creditRows && creditRows.length) {
        await conn.commit();
        conn.release();
        return { ok: true, alreadyProcessed: true };
      }
    }

    if (!paystackData || paystackData.status !== 'success') {
      // mark pending record as failed when available
      if (schema.hasStatus && record) {
        if (schema.hasMeta) await conn.query(`UPDATE balance_transactions SET status = 'failed', meta = ? WHERE id = ?`, [JSON.stringify(paystackData || {}), record.id]);
        else await conn.query(`UPDATE balance_transactions SET status = 'failed' WHERE id = ?`, [record.id]);
      } else {
        await conn.query(
          `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, created_at)
           VALUES (?, ?, 'credit', 'deposit_failed', ?, NOW())`,
          [null, ((paystackData && paystackData.amount) || 0) / 100, reference]
        );
      }
      await conn.commit();
      conn.release();
      return { ok: false, reason: 'payment_not_successful' };
    }

    // success path
    const amountNaira = (paystackData.amount || 0) / 100;

    // determine user
    let userId = record ? record.user_id : null;
    if (!userId && paystackData && paystackData.metadata) {
      if (paystackData.metadata.user_id) userId = paystackData.metadata.user_id;
      else if (paystackData.metadata.token) {
        try {
          const tokenRow = await findToken(String(paystackData.metadata.token), { requireActive: true });
          if (tokenRow && tokenRow.user_id) userId = tokenRow.user_id;
        } catch (e) {}
      }
    }

    if (schema.hasStatus) {
      if (record) {
        if (schema.hasMeta) await conn.query(`UPDATE balance_transactions SET status = 'successful', amount = ?, meta = ? WHERE id = ?`, [amountNaira, JSON.stringify(paystackData || {}), record.id]);
        else await conn.query(`UPDATE balance_transactions SET status = 'successful', amount = ? WHERE id = ?`, [amountNaira, record.id]);
      } else {
        if (schema.hasMeta) {
          await conn.query(
            `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, status, meta, created_at)
             VALUES (?, ?, 'debit', 'deposit_pending', ?, 'successful', ?, NOW())`,
            [userId, amountNaira, reference, JSON.stringify(paystackData || {})]
          );
        } else {
          await conn.query(
            `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, status, created_at)
             VALUES (?, ?, 'debit', 'deposit_pending', ?, 'successful', NOW())`,
            [userId, amountNaira, reference]
          );
        }
      }

      if (userId) {
        await conn.query(`UPDATE users SET balance = IFNULL(balance,0) + ? WHERE id = ?`, [amountNaira, userId]);
        if (schema.hasMeta) {
          await conn.query(
            `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, status, meta, created_at)
             VALUES (?, ?, 'credit', 'deposit', ?, 'successful', ?, NOW())`,
            [userId, amountNaira, reference, JSON.stringify(paystackData || {})]
          );
        } else {
          await conn.query(
            `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, status, created_at)
             VALUES (?, ?, 'credit', 'deposit', ?, 'successful', NOW())`,
            [userId, amountNaira, reference]
          );
        }
      } else {
        if (schema.hasMeta) {
          await conn.query(
            `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, status, meta, created_at)
             VALUES (NULL, ?, 'credit', 'deposit_unlinked', ?, 'successful', ?, NOW())`,
            [amountNaira, reference, JSON.stringify(paystackData || {})]
          );
        } else {
          await conn.query(
            `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, status, created_at)
             VALUES (NULL, ?, 'credit', 'deposit_unlinked', ?, 'successful', NOW())`,
            [amountNaira, reference]
          );
        }
      }
    } else {
      if (record && record.source === 'deposit_pending') {
        await conn.query(`UPDATE balance_transactions SET amount = ? WHERE id = ?`, [amountNaira, record.id]);
      } else if (!record) {
        await conn.query(
          `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, created_at)
           VALUES (?, ?, 'debit', 'deposit_pending', ?, NOW())`,
          [userId, amountNaira, reference]
        );
      }

      if (userId) {
        await conn.query(`UPDATE users SET balance = IFNULL(balance,0) + ? WHERE id = ?`, [amountNaira, userId]);
        await conn.query(
          `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, created_at)
           VALUES (?, ?, 'credit', 'deposit', ?, NOW())`,
          [userId, amountNaira, reference]
        );
      } else {
        await conn.query(
          `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, created_at)
           VALUES (NULL, ?, 'credit', 'deposit_unlinked', ?, NOW())`,
          [amountNaira, reference]
        );
      }
    }

    await conn.commit();
    conn.release();
    console.info('[finalizeDeposit] success', { reference, amount: amountNaira, userId: userId || null });
    return { ok: true, amount: amountNaira };
  } catch (err) {
    await conn.rollback().catch(() => {});
    conn.release();
    console.error('[finalizeDeposit] error', err && err.stack ? err.stack : err);
    throw err;
  }
}

/* ---------- initDeposit ---------- */
async function initDeposit(req, res) {
  try {
    await populateUserFromHeader(req);

    const userId = req.user && req.user.id ? req.user.id : null;
    const { amount, email } = req.body || {};
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const amountNaira = Number(amount);
    const amountKobo = toKobo(amountNaira);
    const fallbackReference = `xtt_${userId || 'guest'}_${Date.now()}`;
    const customerEmail = email || (req.user && req.user.email) || `guest_${Date.now()}@example.com`;

    const paystackResp = await initializeTransaction({
      email: customerEmail,
      amountKobo,
      reference: fallbackReference,
      callback_url: FRONTEND_CALLBACK_URL
    });

    console.info('[initDeposit] paystack init response', {
      ok: paystackResp && paystackResp.status,
      message: paystackResp && paystackResp.message,
      data: paystackResp && paystackResp.data ? {
        reference: paystackResp.data.reference,
        authorization_url: paystackResp.data.authorization_url,
        access_code: paystackResp.data.access_code
      } : null
    });

    if (!paystackResp || !paystackResp.data) {
      console.error('[initDeposit] paystack init failed', paystackResp);
      return res.status(500).json({ error: 'Paystack init failed', detail: paystackResp });
    }

    const actualRef = (paystackResp.data && paystackResp.data.reference) ? paystackResp.data.reference : fallbackReference;

    const pool = await getPool();
    const schema = await detectSchema();

    let metadata = { init: paystackResp.data };
    if (req.authToken && req.authToken.token) metadata.token = req.authToken.token;
    if (!metadata.user_id && userId) metadata.user_id = userId;

    if (schema.hasStatus || schema.hasMeta) {
      if (schema.hasStatus && schema.hasMeta) {
        await pool.query(
          `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, status, meta, created_at)
           VALUES (?, ?, 'debit', 'deposit_pending', ?, 'pending', ?, NOW())`,
          [userId, amountNaira, actualRef, JSON.stringify(metadata)]
        );
      } else if (schema.hasStatus) {
        await pool.query(
          `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, status, created_at)
           VALUES (?, ?, 'debit', 'deposit_pending', ?, 'pending', NOW())`,
          [userId, amountNaira, actualRef]
        );
      } else if (schema.hasMeta) {
        await pool.query(
          `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, meta, created_at)
           VALUES (?, ?, 'debit', 'deposit_pending', ?, ?, NOW())`,
          [userId, amountNaira, actualRef, JSON.stringify(metadata)]
        );
      }
    } else {
      await pool.query(
        `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, created_at)
         VALUES (?, ?, 'debit', 'deposit_pending', ?, NOW())`,
        [userId, amountNaira, actualRef]
      );
    }

    console.info('[initDeposit] canonical_reference', { actualRef, fallbackReference, userId });

    return res.json({
      authorization_url: paystackResp.data.authorization_url,
      reference: actualRef,
      access_code: paystackResp.data.access_code
    });
  } catch (err) {
    console.error('[initDeposit] error', err && err.raw ? err.raw : err);
    return res.status(500).json({ error: 'Could not initialize deposit' });
  }
}

/* ---------- verifyDeposit: resolves placeholder by checking user's latest pending deposit ---------- */
async function verifyDeposit(req, res) {
  try {
    await populateUserFromHeader(req);

    const rawReference = req.params.reference;
    let reference = normalizeAndValidateReference(rawReference);

    // If client sent a placeholder (e.g., "{reference}"), attempt to resolve from authenticated user's most recent pending deposit
    if (!reference) {
      console.warn('[verifyDeposit] invalid reference provided', { rawReference });
      // try to resolve using authenticated user
      if (req.user && req.user.id) {
        try {
          const pool = await getPool();
          // find most recent pending deposit for this user
          const [rows] = await pool.query(
            `SELECT reference_id FROM balance_transactions
             WHERE user_id = ? AND source = 'deposit_pending'
             ORDER BY id DESC LIMIT 1`,
            [req.user.id]
          );
          if (rows && rows.length) {
            const candidate = rows[0].reference_id;
            const candSafe = normalizeAndValidateReference(candidate);
            if (candSafe) {
              reference = candSafe;
              console.info('[verifyDeposit] resolved placeholder to pending reference', { reference, userId: req.user.id });
            }
          }
        } catch (e) {
          console.warn('[verifyDeposit] failed to resolve pending reference', e && e.message);
        }
      }
    }

    if (!reference) {
      return res.status(400).json({ error: 'Invalid reference provided. Ensure you pass the canonical reference returned by /deposit-init or authenticate so server can resolve your pending reference.' });
    }

    console.info('[verifyDeposit] verifying reference', { reference, userId: req.user && req.user.id ? req.user.id : null });

    // call Paystack verify
    let verifyResp;
    try {
      verifyResp = await verifyTransaction(reference);
    } catch (err) {
      // If Paystack responds with transaction not found, surface the raw error to client
      if (err && err.raw && err.raw.code === 'transaction_not_found') {
        console.warn('[verifyDeposit] paystack transaction not found', { reference });
        return res.status(400).json(err.raw || { error: 'Transaction reference not found' });
      }
      throw err;
    }

    if (!verifyResp || !verifyResp.data) {
      console.error('[verifyDeposit] invalid verification response', verifyResp);
      return res.status(500).json({ error: 'Invalid verification response' });
    }

    console.info('[verifyDeposit] paystack verification result', { reference, status: verifyResp.data.status, gateway_response: verifyResp.data.gateway_response });

    const result = await finalizeDeposit(reference, verifyResp.data);
    if (!result.ok) {
      console.warn('[verifyDeposit] finalizeDeposit failed', { reference, reason: result.reason });
      return res.status(400).json({ ok: false, reason: result.reason || 'finalize_failed' });
    }

    return res.json({ ok: true, reference, amount: result.amount, paystack: verifyResp.data });
  } catch (err) {
    console.error('[verifyDeposit] error', err && err.raw ? err.raw : err);
    return res.status(500).json({ error: 'Verification failed', detail: err && err.message ? err.message : err });
  }
}

module.exports = { initDeposit, verifyDeposit, finalizeDeposit };
