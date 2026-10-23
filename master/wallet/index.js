// Cliente de la wallet de la central (protocolo v3).
//
// Reglas (ADR 0004, ADR 0005 y Referencia de la API v3):
// - Toda escritura se persiste en wallet_ops ANTES de enviarse. Su idpk es la
//   Idempotency-Key y se reutiliza en cada reintento, con el mismo cuerpo exacto.
// - 202: aceptada; el resultado llega después como evento por city.{CODE}.
// - 200: la wallet ya conocía la llave y devuelve el estado actual del swap.
// - 502, 503, 504, timeout o error de red: la operación puede haberse procesado;
//   se reintenta con la MISMA llave.
// - 429: se espera lo que indica Retry-After y se reintenta con la misma llave.
// - 401, 404, 422: rechazo definitivo; no se reintenta.
// - Si se agotan los intentos sin respuesta definitiva, la operación queda
//   'pending' y el worker la retoma más tarde. Nunca se da por fallida por tiempo.
const { randomUUID } = require('node:crypto');

let newrelic = null;
try { newrelic = require('newrelic'); } catch { newrelic = null; }

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const FINAL_FAILURE_STATUS = new Set([401, 404, 422]);
const ASSETS = new Set(['CR', 'KWH']);
const MAX_SWAP_TTL_MS = 60_000;
const MAX_MEMO_LENGTH = 128;

class WalletError extends Error {
  constructor(message, { status, reason, body } = {}) {
    super(message);
    this.name = 'WalletError';
    this.status = status;
    this.reason = reason;
    this.body = body;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function round2(value) {
  return Math.round(value * 100) / 100;
}

function normalizeLeg(leg, name) {
  if (!leg || !ASSETS.has(leg.asset)) throw new WalletError(`${name}.asset debe ser CR o KWH`);
  if (!Number.isFinite(leg.amount) || leg.amount <= 0) throw new WalletError(`${name}.amount debe ser positivo`);
  if (leg.asset === 'KWH') {
    if (!Number.isInteger(leg.amount)) throw new WalletError(`${name}.amount en KWH debe ser entero`);
    return { asset: 'KWH', amount: leg.amount };
  }
  return { asset: 'CR', amount: round2(leg.amount) };
}

// Retry-After puede venir en segundos o como fecha HTTP.
function parseRetryAfter(value, nowMs, fallbackMs, maxMs) {
  if (value == null || value === '') return fallbackMs;
  const seconds = Number(value);
  let ms;
  if (Number.isFinite(seconds)) ms = seconds * 1000;
  else {
    const date = Date.parse(value);
    ms = Number.isFinite(date) ? date - nowMs : fallbackMs;
  }
  return Math.min(Math.max(ms, 0), maxMs);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Eventos que cierran una propuesta nuestra aunque traigan el idpk de otra ciudad
// (swap-settled al vendedor trae el idpk del accept del comprador) o ninguno
// (swap-expired), o el de la central (swap-cancelled del cierre del mercado).
const CLOSES_PROPOSAL = new Set(['swap-settled', 'swap-expired', 'swap-cancelled']);

// Marca la operación con el evento de la wallet que la resolvió.
// 1) Por data.idpk = Idempotency-Key de nuestra operación.
// 2) Si no calza y el evento cierra un swap, por swapId con nuestra propuesta.
// Devuelve false si el evento no corresponde a ninguna operación nuestra.
// Nunca lanza por un idpk con formato inesperado: un error aquí revertiría la
// transacción del evento y el connector lo reencolaría sin fin.
async function onWalletEvent(db, event) {
  if (!event || typeof event.type !== 'string' || !event.type.startsWith('swap-')) return false;
  const data = event.data || {};
  const resultBody = JSON.stringify({ reason: event.reason ?? null, code: event.code ?? null, data });

  if (typeof data.idpk === 'string' && UUID_PATTERN.test(data.idpk)) {
    const byKey = await db.query(
      `UPDATE wallet_ops
       SET status = 'resolved', result_event = $2, result_event_body = $3,
           swap_id = COALESCE(swap_id, $4), updated_at = now()
       WHERE idpk = $1 AND status <> 'resolved'`,
      [data.idpk.toLowerCase(), event.type, resultBody, data.swapId || null]
    );
    if (byKey.rowCount > 0) return true;
  }

  if (CLOSES_PROPOSAL.has(event.type) && data.swapId) {
    const bySwap = await db.query(
      `UPDATE wallet_ops
       SET status = 'resolved', result_event = $2, result_event_body = $3, updated_at = now()
       WHERE swap_id = $1 AND operation = 'propose' AND status <> 'resolved'`,
      [data.swapId, event.type, resultBody]
    );
    return bySwap.rowCount > 0;
  }
  return false;
}

function createWalletClient({
  pool,
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  now = () => Date.now(),
  timeoutMs = 10_000,
  maxAttempts = 6,
  baseDelayMs = 500,
  maxDelayMs = 8_000,
  maxRetryAfterMs = 60_000,
  leaseMs = 120_000,
  logger = console,
} = {}) {
  if (!pool) throw new Error('createWalletClient requiere pool');
  if (!baseUrl) throw new Error('Falta WALLET_BASE_URL');
  if (!apiKey) throw new Error('Falta WALLET_API_KEY');
  const root = baseUrl.replace(/\/+$/, '');

  function backoff(attempt) {
    const exp = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

  function record(attrs) {
    if (newrelic && typeof newrelic.recordCustomEvent === 'function') {
      newrelic.recordCustomEvent('WalletCall', attrs);
    }
  }

  // Una llamada HTTP. Nunca lanza por errores de red: los devuelve como resultado.
  async function send(method, path, { body, idpk, operation } = {}) {
    const headers = { 'X-Api-Key': apiKey, Accept: 'application/json' };
    if (idpk) headers['Idempotency-Key'] = idpk;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const started = now();
    let status = 0;
    let parsed = null;
    let retryAfter = null;
    let networkError = null;
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      retryAfter = response.headers?.get?.('retry-after') ?? null;
      const text = await response.text();
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      }
    } catch (err) {
      networkError = err.name === 'TimeoutError' ? 'TIMEOUT' : (err.code || err.message || 'NETWORK_ERROR');
    }
    record({
      operation: operation || method.toLowerCase(),
      method,
      path: path.split('?')[0],
      status,
      reason: parsed?.reason || networkError || null,
      durationMs: now() - started,
      idpk: idpk || null,
    });
    return { status, body: parsed, retryAfter, networkError };
  }

  // ---------- Escrituras ----------

  // Persiste una operación sin enviarla. Acepta un cliente de una transacción
  // abierta, para que la reserva (ADR 0004) y la operación queden juntas.
  async function persistOperation(db, { operation, swapId = null, body = null, idpk = randomUUID(), deadline = null }) {
    let requestPath;
    if (operation === 'propose') requestPath = '/swaps';
    else if (operation === 'accept' || operation === 'cancel') {
      if (!swapId) throw new WalletError(`${operation} requiere swapId`);
      requestPath = `/swaps/${encodeURIComponent(swapId)}/${operation}`;
    } else throw new WalletError(`Operación desconocida: ${operation}`);

    await (db || pool).query(
      `INSERT INTO wallet_ops (idpk, operation, swap_id, request_path, request_body, deadline, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idpk) DO NOTHING`,
      [idpk, operation, swapId, requestPath, body === null ? null : JSON.stringify(body),
        deadline ? new Date(deadline) : null, new Date(now())]
    );
    return idpk;
  }

  // Toma la operación para enviarla (evita que el worker y el llamador la envíen a la vez).
  async function claim(idpk) {
    const result = await pool.query(
      `UPDATE wallet_ops SET next_attempt_at = $2, updated_at = now()
       WHERE idpk = $1 AND status = 'pending' AND next_attempt_at <= $3
       RETURNING *`,
      [idpk, new Date(now() + leaseMs), new Date(now())]
    );
    return result.rows[0] || null;
  }

  async function getOperation(idpk) {
    const result = await pool.query('SELECT * FROM wallet_ops WHERE idpk = $1', [idpk]);
    return result.rows[0] || null;
  }

  async function update(idpk, fields) {
    const keys = Object.keys(fields);
    const sets = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
    const values = keys.map((key) => {
      const value = fields[key];
      return value !== null && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value;
    });
    const result = await pool.query(
      `UPDATE wallet_ops SET ${sets}, updated_at = now() WHERE idpk = $1 RETURNING *`,
      [idpk, ...values]
    );
    return result.rows[0];
  }

  // Envía una operación persistida hasta obtener una respuesta definitiva o agotar intentos.
  async function execute(idpk) {
    const op = await claim(idpk);
    if (!op) return getOperation(idpk); // ya resuelta, o en curso en otro proceso

    const body = op.request_body;
    let attempts = op.attempts;
    let transientFailures = 0;

    while (true) {
      if (op.deadline && now() >= new Date(op.deadline).getTime()) {
        // Sin resultado conocido: queda pending. Lo resuelve el evento o el cierre del mercado.
        return update(idpk, { next_attempt_at: new Date(now() + maxDelayMs), last_error: 'DEADLINE_REACHED' });
      }

      attempts += 1;
      await update(idpk, { attempts });
      const res = await send('POST', op.request_path, { body: body ?? undefined, idpk, operation: op.operation });

      if (res.status === 202 || res.status === 200) {
        return update(idpk, {
          status: 'accepted',
          swap_id: res.body?.swapId || op.swap_id,
          last_http_status: res.status,
          last_error: null,
          response_body: res.body,
        });
      }

      if (FINAL_FAILURE_STATUS.has(res.status)) {
        const reason = res.body?.reason || `HTTP_${res.status}`;
        if (reason === 'IDEMPOTENCY_MISMATCH') {
          logger.error(`[wallet] IDEMPOTENCY_MISMATCH en ${idpk}: se reenvió la llave con otro cuerpo. Es un bug.`);
        }
        return update(idpk, { status: 'failed', last_http_status: res.status, last_error: reason, response_body: res.body });
      }

      if (res.status === 429) {
        const wait = parseRetryAfter(res.retryAfter, now(), baseDelayMs, maxRetryAfterMs);
        await update(idpk, { last_http_status: 429, last_error: 'RATE_LIMITED' });
        logger.warn(`[wallet] 429 en ${op.operation} ${idpk}; reintento en ${wait} ms`);
        await sleep(wait);
        continue; // el 429 no cuenta como fallo transitorio
      }

      // 5xx, timeout o red: puede haberse procesado. Reintento con la misma llave.
      transientFailures += 1;
      const lastError = res.networkError || res.body?.reason || `HTTP_${res.status}`;
      if (transientFailures >= maxAttempts) {
        logger.warn(`[wallet] ${op.operation} ${idpk} sin respuesta definitiva tras ${transientFailures} intentos; queda pendiente`);
        return update(idpk, {
          last_http_status: res.status || null,
          last_error: lastError,
          next_attempt_at: new Date(now() + maxDelayMs),
        });
      }
      await update(idpk, { last_http_status: res.status || null, last_error: lastError });
      await sleep(backoff(transientFailures));
    }
  }

  function checkExpiresAt(expiresAt) {
    const ms = Date.parse(expiresAt);
    if (!Number.isFinite(ms)) throw new WalletError('expiresAt inválido');
    if (ms - now() > MAX_SWAP_TTL_MS) throw new WalletError('expiresAt no puede superar 60 s desde ahora');
    return new Date(ms).toISOString();
  }

  async function proposeSwap({ give, take, expiresAt, memo }, { idpk, deadline, db } = {}) {
    const body = {
      give: normalizeLeg(give, 'give'),
      take: normalizeLeg(take, 'take'),
      expiresAt: checkExpiresAt(expiresAt),
      memo: String(memo ?? ''),
    };
    if (body.give.asset === body.take.asset) throw new WalletError('give y take deben ser de distinto activo');
    if (body.memo.length > MAX_MEMO_LENGTH) throw new WalletError('memo supera 128 caracteres');
    const key = await persistOperation(db, { operation: 'propose', body, idpk, deadline });
    return db ? key : execute(key);
  }

  async function acceptSwap(swapId, { idpk, deadline, db } = {}) {
    const key = await persistOperation(db, { operation: 'accept', swapId, idpk, deadline });
    return db ? key : execute(key);
  }

  async function cancelSwap(swapId, { idpk, deadline, db } = {}) {
    const key = await persistOperation(db, { operation: 'cancel', swapId, idpk, deadline });
    return db ? key : execute(key);
  }

  // Retoma operaciones pendientes: las de un proceso que se reinició o las que agotaron intentos.
  async function retryPending({ limit = 20 } = {}) {
    const result = await pool.query(
      `SELECT idpk FROM wallet_ops
       WHERE status = 'pending' AND next_attempt_at <= $1
       ORDER BY created_at LIMIT $2`,
      [new Date(now()), limit]
    );
    const done = [];
    for (const row of result.rows) done.push(await execute(row.idpk));
    return done;
  }

  function startRetryWorker({ intervalMs = 5_000 } = {}) {
    const health = { enabled: true, startedAt: new Date().toISOString(), lastTick: null, lastError: null };
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await retryPending();
        health.lastTick = new Date().toISOString();
        health.lastError = null;
      } catch (err) {
        health.lastError = err.message;
        logger.error('[wallet] Error en el worker de reintentos:', err.message);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    tick();
    return { health, wake: tick, stop: () => clearInterval(timer) };
  }

  // ---------- Lecturas ----------

  async function read(path) {
    let transientFailures = 0;
    while (true) {
      const res = await send('GET', path);
      if (res.status >= 200 && res.status < 300) return res.body;
      if (res.status === 429) {
        await sleep(parseRetryAfter(res.retryAfter, now(), baseDelayMs, maxRetryAfterMs));
        continue;
      }
      if (FINAL_FAILURE_STATUS.has(res.status)) {
        throw new WalletError(`Wallet respondió ${res.status} en GET ${path}`, {
          status: res.status, reason: res.body?.reason, body: res.body,
        });
      }
      transientFailures += 1;
      if (transientFailures >= maxAttempts) {
        throw new WalletError(`Wallet no respondió en GET ${path}`, {
          status: res.status, reason: res.networkError || res.body?.reason,
        });
      }
      await sleep(backoff(transientFailures));
    }
  }

  const getSwap = (swapId) => read(`/swaps/${encodeURIComponent(swapId)}`);
  const getBalance = () => read('/balance');
  const getLeaderboard = () => read('/leaderboard');
  function getStatement({ cycleId, asset, cursor, limit } = {}) {
    const params = new URLSearchParams();
    if (cycleId) params.set('cycleId', cycleId);
    if (asset) params.set('asset', asset);
    if (cursor) params.set('cursor', cursor);
    if (limit) params.set('limit', String(limit));
    const query = params.toString();
    return read(`/statement${query ? `?${query}` : ''}`);
  }

  return {
    persistOperation,
    execute,
    proposeSwap,
    acceptSwap,
    cancelSwap,
    retryPending,
    startRetryWorker,
    onWalletEvent: (db, event) => onWalletEvent(db || pool, event),
    getOperation,
    getSwap,
    getBalance,
    getStatement,
    getLeaderboard,
  };
}

module.exports = { createWalletClient, onWalletEvent, WalletError, parseRetryAfter };
