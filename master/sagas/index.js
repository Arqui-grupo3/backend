/**
 * master/sagas/index.js
 * Endpoint interno autenticado por HMAC-SHA256 para callbacks terminales de Step Functions (AD7).
 */
const { createHmac, timingSafeEqual } = require('node:crypto');
const seller = require('../seller');

const MAX_REPLAY_WINDOW_SEC = 300;
const VALID_OUTCOMES = new Set(['settled', 'compensated', 'rejected']);
const VALID_ROLES = new Set(['seller', 'buyer']);

function signSagaPayload(secret, timestampSec, idpk, rawBody) {
  return createHmac('sha256', secret)
    .update(`${timestampSec}.${idpk}.${rawBody}`)
    .digest('hex');
}

function verifySagaHmac({
  secret,
  timestampHeader,
  signatureHeader,
  idpk,
  rawBody,
  nowMs = Date.now(),
  maxWindowSec = MAX_REPLAY_WINDOW_SEC
}) {
  if (!secret || typeof secret !== 'string') {
    return { ok: false, error: 'INTERNAL_SAGA_HMAC_SECRET no configurado' };
  }
  const ts = Number(timestampHeader);
  if (!Number.isInteger(ts) || ts <= 0) {
    return { ok: false, error: 'Header X-Saga-Timestamp invalido' };
  }
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - ts) > maxWindowSec) {
    return { ok: false, error: 'Timestamp fuera de ventana permitida' };
  }
  if (typeof signatureHeader !== 'string' || !/^[0-9a-f]{64}$/i.test(signatureHeader)) {
    return { ok: false, error: 'Header X-Saga-Signature invalido' };
  }
  const expected = signSagaPayload(secret, ts, idpk, rawBody);
  const a = Buffer.from(signatureHeader.toLowerCase(), 'hex');
  const b = Buffer.from(expected.toLowerCase(), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: 'Firma HMAC invalida' };
  }
  return { ok: true };
}

/**
 * Aplica el resultado terminal de una saga (settled / compensated / rejected)
 * registrando en saga_runs y, para seller, actualizando seller_bids de forma idempotente.
 */
async function recordSagaResult(pool, {
  idpk,
  body = {},
  connectorUrl,
  fetchFn = globalThis.fetch
} = {}) {
  if (!idpk || typeof idpk !== 'string') {
    const err = new Error('idpk requerido');
    err.statusCode = 422;
    throw err;
  }

  const role = VALID_ROLES.has(body.role) ? body.role : 'seller';
  const outcome = body.outcome;
  if (!VALID_OUTCOMES.has(outcome)) {
    const err = new Error('outcome debe ser settled, compensated o rejected');
    err.statusCode = 422;
    throw err;
  }

  const swapId = typeof body.swapId === 'string' && body.swapId ? body.swapId : null;
  const swapIdpk = typeof body.swapIdpk === 'string' && body.swapIdpk ? body.swapIdpk : null;
  const cycleId = typeof body.cycleId === 'string' && body.cycleId ? body.cycleId : null;
  const offerId = typeof body.offerId === 'string' && body.offerId ? body.offerId : null;
  const executionName = typeof body.executionName === 'string' && body.executionName ? body.executionName : idpk;
  const reason = typeof body.reason === 'string' && body.reason ? body.reason.slice(0, 200) : null;
  const startedAt = body.startedAt && Number.isFinite(Date.parse(body.startedAt)) ? body.startedAt : null;
  const closesAt = body.closesAt && Number.isFinite(Date.parse(body.closesAt)) ? body.closesAt : null;

  const upsert = await pool.query(
    `INSERT INTO saga_runs
       (idpk, execution_name, role, cycle_id, offer_id, swap_id, swap_idpk, status, reason, started_at, finished_at, closes_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()), now(), $11::timestamptz, now())
     ON CONFLICT (idpk) DO UPDATE SET
       execution_name = COALESCE(EXCLUDED.execution_name, saga_runs.execution_name),
       swap_id = COALESCE(EXCLUDED.swap_id, saga_runs.swap_id),
       swap_idpk = COALESCE(EXCLUDED.swap_idpk, saga_runs.swap_idpk),
       status = EXCLUDED.status,
       reason = COALESCE(EXCLUDED.reason, saga_runs.reason),
       finished_at = COALESCE(saga_runs.finished_at, now()),
       closes_at = COALESCE(EXCLUDED.closes_at, saga_runs.closes_at),
       updated_at = now()
     RETURNING idpk, execution_name AS "executionName", role, cycle_id AS "cycleId",
               offer_id AS "offerId", swap_id AS "swapId", status, reason,
               started_at AS "startedAt", finished_at AS "finishedAt", closes_at AS "closesAt"`,
    [idpk, executionName, role, cycleId, offerId, swapId, swapIdpk, outcome, reason, startedAt, closesAt]
  );

  let sellerAction = null;
  if (role === 'seller') {
    if (outcome === 'settled' && (swapId || swapIdpk)) {
      sellerAction = await seller.handleSwapSettled(pool, { swapId, swapIdpk });
    } else if (outcome === 'compensated') {
      if (body.proposalRejected) {
        const bidRow = await pool.query(
          `SELECT raw_payload AS "rawPayload" FROM seller_bids WHERE idpk = $1`,
          [idpk]
        );
        const bidEvent = bidRow.rows[0]?.rawPayload || null;
        if (bidEvent) {
          sellerAction = await seller.releaseAndReject(pool, { idpk, bidEvent, connectorUrl, fetchFn });
        }
      }
      if (!sellerAction && (swapId || swapIdpk)) {
        sellerAction = await seller.releaseSwap(
          pool,
          { swapId, swapIdpk, reason: reason || 'SAGA_COMPENSATED' },
          { connectorUrl, fetchFn }
        );
      }
    }
  }

  return {
    run: upsert.rows[0],
    sellerAction: Boolean(sellerAction)
  };
}

module.exports = {
  signSagaPayload,
  verifySagaHmac,
  recordSagaResult,
  MAX_REPLAY_WINDOW_SEC
};
