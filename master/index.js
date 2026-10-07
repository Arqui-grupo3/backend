require('newrelic');
require('dotenv').config();
const express = require('express');
const { createPublicKey, randomUUID, verify } = require('crypto');
const { Pool } = require('pg');
const ledger = require('./ledger');

const PORT = process.env.PORT || 3000;
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === 'true';
const AUTH0_ISSUER = process.env.AUTH0_ISSUER;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;
const AUTH0_JWKS_URL = process.env.AUTH0_JWKS_URL || (AUTH0_ISSUER ? `${AUTH0_ISSUER.replace(/\/$/, '')}/.well-known/jwks.json` : null);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const CONNECTOR_URL = process.env.CONNECTOR_URL || 'http://connector:3001';
const MAX_PAGE_LIMIT = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

let jwksCache = { expiresAt: 0, keys: new Map() };

function unauthorized(res, message = 'Autenticacion requerida') {
  return res.status(401).json({ error: message });
}

async function getSigningKey(kid) {
  if (!AUTH0_JWKS_URL) throw new Error('Falta AUTH0_JWKS_URL');
  if (Date.now() >= jwksCache.expiresAt) {
    const response = await fetch(AUTH0_JWKS_URL);
    if (!response.ok) throw new Error(`No se pudo obtener el JWKS (${response.status})`);
    const body = await response.json();
    jwksCache = {
      expiresAt: Date.now() + 15 * 60 * 1000,
      keys: new Map((body.keys || []).map((key) => [key.kid, key])),
    };
  }
  const jwk = jwksCache.keys.get(kid);
  if (!jwk) throw new Error('La llave del token no esta en el JWKS');
  return createPublicKey({ key: jwk, format: 'jwk' });
}

async function authenticate(req, res, next) {
  if (!AUTH_REQUIRED) return next();
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return unauthorized(res);

  try {
    const [encodedHeader, encodedPayload, encodedSignature] = match[1].split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature) return unauthorized(res, 'Token invalido');
    const tokenHeader = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (tokenHeader.alg !== 'RS256' || typeof tokenHeader.kid !== 'string') return unauthorized(res, 'Algoritmo de token no permitido');
    const audienceValid = Array.isArray(claims.aud)
      ? claims.aud.includes(AUTH0_AUDIENCE)
      : claims.aud === AUTH0_AUDIENCE;
    if (claims.iss !== AUTH0_ISSUER || !audienceValid || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) {
      return unauthorized(res, 'Claims del token invalidos');
    }
    const key = await getSigningKey(tokenHeader.kid);
    const valid = verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      key,
      Buffer.from(encodedSignature, 'base64url')
    );
    if (!valid) return unauthorized(res, 'Firma del token invalida');
    req.auth = claims;
    return next();
  } catch (err) {
    console.error('[master] Error autenticando request:', err.message);
    return unauthorized(res, 'Token invalido');
  }
}

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || 'energyshark',
  password: process.env.PGPASSWORD || 'energyshark',
  database: process.env.PGDATABASE || 'energyshark',
});

pool.on('error', (err) => {
  console.error('[master] Error inesperado en el pool de Postgres:', err.message);
});

async function initDb() {
  const maxRetries = 30;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS events (
          id UUID PRIMARY KEY,
          idpk TEXT UNIQUE NOT NULL,
          msg_id UUID,
          type TEXT NOT NULL,
          cycle_id TEXT,
          package_body JSONB,
          received_at TIMESTAMPTZ NOT NULL,
          seq BIGSERIAL
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS api_audit (
          id UUID PRIMARY KEY,
          idpk TEXT,
          msg_id UUID,
          type TEXT NOT NULL,
          cycle_id TEXT,
          reason TEXT NOT NULL,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          received_at TIMESTAMPTZ NOT NULL,
          seq BIGSERIAL
        );
      `);
      await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS msg_id UUID;');
      await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS cycle_id TEXT;');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_events_seq ON events (seq);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_events_cycle_id ON events (cycle_id);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_api_audit_received_at ON api_audit (received_at DESC);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_api_audit_reason ON api_audit (reason);');
      await ledger.migrate(pool);
      console.log('[master] Conectado a Postgres. Tabla "events" lista.');
      return;
    } catch (err) {
      console.error(`[master] Postgres no disponible aun (intento ${attempt}/${maxRetries}): ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  console.error('[master] No se pudo conectar a Postgres tras varios intentos. Saliendo.');
  process.exit(1);
}

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM events');
    res.status(200).json({ status: 'ok', uptime: process.uptime(), count: result.rows[0].count });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

async function insertEvent(event) {
  return ledger.recordEvent(pool, event);
}

async function forwardToConnector(path, body) {
  const response = await fetch(`${CONNECTOR_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `connector respondió ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return result;
}

app.post('/audit', async (req, res) => {
  const { idpk = null, msgId = null, type = 'unknown', cycleId = null, reason, details = {}, receivedAt } = req.body || {};
  if (!['DUPLICATE_IDPK', 'DISCARDED', 'NACK'].includes(reason)) {
    return res.status(400).json({ error: 'reason de auditoria invalido' });
  }
  try {
    await pool.query(
      `INSERT INTO api_audit (id, idpk, msg_id, type, cycle_id, reason, details, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        idpk,
        UUID_PATTERN.test(String(msgId || '')) ? msgId : null,
        type,
        cycleId,
        reason,
        details,
        receivedAt || new Date().toISOString(),
      ]
    );
    return res.status(201).json({ recorded: true });
  } catch (err) {
    console.error('[master] Error al registrar auditoria:', err.message);
    return res.status(500).json({ error: 'Error interno al registrar auditoria' });
  }
});

app.get('/audit', authenticate, async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), MAX_PAGE_LIMIT);
  const allowedReasons = new Set(['DUPLICATE_IDPK', 'DISCARDED', 'NACK']);
  const reason = req.query.reason === undefined ? null : String(req.query.reason);

  if (reason !== null && !allowedReasons.has(reason)) {
    return res.status(400).json({ error: 'reason debe ser DUPLICATE_IDPK, DISCARDED o NACK' });
  }

  const values = [];
  const whereSql = reason === null ? '' : 'WHERE reason = $1';
  if (reason !== null) values.push(reason);

  try {
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM api_audit ${whereSql}`, values);
    const total = countResult.rows[0].total;
    const offset = (page - 1) * limit;
    const result = await pool.query(
      `SELECT id, idpk, msg_id AS "msgId", type, cycle_id AS "cycleId",
              reason, details, received_at AS "receivedAt"
       FROM api_audit ${whereSql}
       ORDER BY seq DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );
    return res.json({
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      data: result.rows,
    });
  } catch (err) {
    console.error('[master] Error al consultar /audit:', err.message);
    return res.status(500).json({ error: 'Error interno al consultar auditoria' });
  }
});

app.post('/events', async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body invalido, se esperaba JSON' });
  }

  const { idpk, type, receivedAt } = body;

  if (!idpk || !type) {
    return res.status(400).json({ error: 'Faltan campos requeridos: idpk, type' });
  }

  const receivedAtValue = receivedAt || new Date().toISOString();

  try {
    const result = await insertEvent({ ...body, receivedAt: receivedAtValue });

    if (!result.inserted) {
      return res.status(200).json({ message: 'Evento ya registrado (idpk duplicado)', idpk, duplicate: true });
    }

    console.log(`[master] Evento almacenado. id=${result.id} idpk=${idpk}`);
    res.status(201).json({ id: result.id, ledgerApplied: result.ledgerApplied });
  } catch (err) {
    console.error('[master] Error al guardar evento:', err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode === 422 ? err.message : 'Error interno al guardar el evento' });
  }
});

// Phase 1 projection; not final RF03 balances (demand/negotiations pending).
app.get('/cycles/:cycleId/ledger', authenticate, async (req, res) => {
  try {
    const state = await ledger.getCycleState(pool, req.params.cycleId);
    if (!state) return res.status(404).json({ error: 'Ciclo sin operaciones de ledger' });
    res.json({ ...state, scope: 'phase1-status-and-incoming-transfers', historicalBaseline: 'zero-at-ledger-installation' });
  } catch (err) {
    console.error('[master] Error al consultar ledger:', err.message);
    res.status(500).json({ error: 'Error al consultar ledger' });
  }
});

app.get('/cycles', authenticate, async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), MAX_PAGE_LIMIT);
  try {
    const result = await pool.query(
      `SELECT cycle_id AS "cycleId",
              COUNT(*)::int AS "operationCount",
              MIN(received_at) AS "startedAt",
              MAX(received_at) AS "lastOperationAt",
              (ARRAY_AGG(type ORDER BY seq DESC))[1] AS "lastOperationType",
              COALESCE(JSONB_AGG(package_body) FILTER (WHERE type = 'status-statement'), '[]') AS "statusStatements",
              COALESCE(JSONB_AGG(package_body) FILTER (WHERE type = 'transfer'), '[]') AS transfers,
              COALESCE(JSONB_AGG(package_body) FILTER (WHERE type = 'demand-statement'), '[]') AS "demandStatements",
              COALESCE(JSONB_AGG(package_body) FILTER (WHERE type = 'negotiation-proposal'), '[]') AS negotiations,
              COALESCE(JSONB_AGG(package_body) FILTER (WHERE type = 'negotiation-report'), '[]') AS "negotiationReports",
              (ARRAY_AGG(package_body ORDER BY seq DESC) FILTER (WHERE type = 'negotiation-report'))[1] AS "finalBalances"
       FROM events
       WHERE cycle_id IS NOT NULL
       GROUP BY cycle_id
       ORDER BY MAX(seq) DESC
       LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit]
    );
    return res.json({ page, limit, data: result.rows });
  } catch (err) {
    console.error('[master] Error al consultar /cycles:', err.message);
    return res.status(500).json({ error: 'Error interno al consultar ciclos' });
  }
});

app.get('/cycles/:cycleId', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cycle_id AS "cycleId",
              COUNT(*)::int AS "operationCount",
              COALESCE(JSONB_AGG(package_body ORDER BY seq) FILTER (WHERE type = 'status-statement'), '[]') AS "statusStatements",
              COALESCE(JSONB_AGG(package_body ORDER BY seq) FILTER (WHERE type = 'transfer'), '[]') AS transfers,
              COALESCE(JSONB_AGG(package_body ORDER BY seq) FILTER (WHERE type = 'demand-statement'), '[]') AS "demandStatements",
              COALESCE(JSONB_AGG(package_body ORDER BY seq) FILTER (WHERE type IN ('negotiation-proposal', 'give', 'take', 'transfer')), '[]') AS negotiations,
              COALESCE(JSONB_AGG(package_body ORDER BY seq) FILTER (WHERE type = 'negotiation-report'), '[]') AS "negotiationReports",
              (ARRAY_AGG(package_body ORDER BY seq DESC) FILTER (WHERE type = 'negotiation-report'))[1] AS "finalBalances",
              (ARRAY_AGG(type ORDER BY seq DESC))[1] AS "lastOperationType",
              (ARRAY_AGG(received_at ORDER BY seq DESC))[1] AS "lastOperationAt"
       FROM events
       WHERE cycle_id = $1
       GROUP BY cycle_id`,
      [req.params.cycleId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Ciclo no encontrado' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[master] Error al consultar ciclo:', err.message);
    return res.status(500).json({ error: 'Error interno al consultar ciclo' });
  }
});

app.post('/negotiations', authenticate, async (req, res) => {
  const { cycleId, direction, quantity, pricePerEnergy } = req.body || {};
  if (!cycleId || !['give', 'take'].includes(direction) ||
      !Number.isFinite(quantity) || quantity <= 0 ||
      !Number.isFinite(pricePerEnergy) || pricePerEnergy < 0) {
    return res.status(400).json({ error: 'cycleId, direction, quantity y pricePerEnergy invalidos' });
  }
  const event = {
    idpk: randomUUID(),
    type: 'negotiation-proposal',
    cycleId,
    data: { direction, quantity, pricePerEnergy },
  };
  try {
    const message = await forwardToConnector('/publish', event);
    const stored = await insertEvent({ ...message, receivedAt: new Date().toISOString() });
    return res.status(201).json({ ...message, eventId: stored.id, status: 'pending' });
  } catch (err) {
    console.error('[master] Error al publicar propuesta:', err.message);
    return res.status(err.statusCode || 502).json({ error: 'No se pudo publicar la propuesta' });
  }
});

app.get('/history', authenticate, async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), MAX_PAGE_LIMIT);

  const allowedColumns = {
    id: 'id', idpk: 'idpk', msgId: 'msg_id', type: 'type', cycleId: 'cycle_id', receivedAt: 'received_at',
  };
  const reserved = new Set(['page', 'limit']);

  const whereClauses = [];
  const values = [];

  for (const [key, value] of Object.entries(req.query)) {
    if (reserved.has(key)) continue;
    const column = allowedColumns[key];
    if (!column) {
      return res.status(400).json({ error: `Parametro de filtro no soportado: ${key}` });
    }

    if (column === 'received_at' && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      values.push(`${value}%`);
      whereClauses.push(`received_at::text LIKE $${values.length}`);
    } else {
      values.push(String(value));
      whereClauses.push(`${column}::text = $${values.length}`);
    }
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  try {
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM events ${whereSql}`, values);
    const total = countResult.rows[0].total;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const offset = (page - 1) * limit;

    const dataResult = await pool.query(
            `SELECT id, idpk, msg_id AS "msgId", type, cycle_id AS "cycleId",
              package_body AS data, received_at AS "receivedAt",
              CASE WHEN ROW_NUMBER() OVER (PARTITION BY cycle_id ORDER BY seq DESC) = 1
                   THEN true ELSE false END AS "lastOperation"
       FROM events
       ${whereSql}
       ORDER BY seq ASC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    res.json({ page, limit, total, totalPages, data: dataResult.rows });
  } catch (err) {
    console.error('[master] Error al consultar /history:', err.message);
    res.status(500).json({ error: 'Error interno al consultar el historial' });
  }
});

app.get('/history/:id', authenticate, async (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'El id debe ser un UUID valido' });
  }
  try {
    const result = await pool.query(
            `SELECT id, idpk, msg_id AS "msgId", type, cycle_id AS "cycleId",
              package_body AS data, received_at AS "receivedAt"
       FROM events WHERE id = $1`,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Registro no encontrado' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[master] Error al consultar /history/:id:', err.message);
    res.status(500).json({ error: 'Error interno al consultar el registro' });
  }
});

app.get('/connectivity', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, cycle_id AS "cycleId", package_body AS data, received_at AS "receivedAt"
       FROM events
       WHERE type = 'distance-table'
       ORDER BY seq DESC
       LIMIT 1`
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error('[master] Error al consultar /connectivity:', err.message);
    res.status(500).json({ error: 'Error interno al consultar conectividad' });
  }
});

app.get('/negotiations', authenticate, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  try {
    const result = await pool.query(
      `SELECT id, idpk, msg_id AS "msgId", cycle_id AS "cycleId", type,
              package_body AS data, received_at AS "receivedAt",
              CASE type
                WHEN 'negotiation-proposal' THEN CASE
                  WHEN EXISTS (
                    SELECT 1 FROM events confirmation
                    WHERE confirmation.type IN ('give', 'take')
                      AND confirmation.package_body->>'target' = events.msg_id::text
                  ) AND EXISTS (
                    SELECT 1 FROM events payment
                    WHERE payment.type = 'transfer'
                      AND payment.package_body->>'becauseOf' IN (
                        SELECT confirmation.msg_id::text FROM events confirmation
                        WHERE confirmation.type IN ('give', 'take')
                          AND confirmation.package_body->>'target' = events.msg_id::text
                      )
                  ) THEN 'paid'
                  WHEN EXISTS (
                    SELECT 1 FROM events confirmation
                    WHERE confirmation.type IN ('give', 'take')
                      AND confirmation.package_body->>'target' = events.msg_id::text
                  ) THEN 'confirmed'
                  WHEN EXISTS (
                    SELECT 1 FROM events failure
                    WHERE failure.type = 'error'
                      AND failure.package_body->>'target' = events.msg_id::text
                  ) THEN 'expired'
                  ELSE 'pending'
                END
                WHEN 'give' THEN 'confirmed'
                WHEN 'take' THEN 'confirmed'
                WHEN 'transfer' THEN 'paid'
                WHEN 'error' THEN 'failed'
                ELSE 'unknown'
              END AS status
       FROM events
       WHERE type IN ('negotiation-proposal', 'give', 'take', 'transfer', 'negotiation-report', 'error')
       ORDER BY seq DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[master] Error al consultar /negotiations:', err.message);
    res.status(500).json({ error: 'Error interno al consultar negociaciones' });
  }
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`[master] Escuchando en http://localhost:${PORT}`);
  });
});
