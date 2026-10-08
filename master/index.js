require('newrelic');
require('dotenv').config();
const express = require('express');
const { createPublicKey, randomUUID, verify } = require('crypto');
const { Pool } = require('pg');
const ledger = require('./ledger');
const reports = require('./reports');
const negotiations = require('./negotiations');

const REPORTS_ENABLED = process.env.REPORTS_ENABLED === 'true';
if (REPORTS_ENABLED && process.env.LEDGER_BASELINE_CONFIRMED !== 'true') {
  throw new Error('Reportes requieren LEDGER_BASELINE_CONFIRMED=true tras verificar el saldo inicial.');
}

let reportWorker;
let negotiationWorker;

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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
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
      await pool.query('CREATE INDEX IF NOT EXISTS idx_events_seq ON events (seq);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_events_cycle_id ON events (cycle_id);');

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
      await pool.query('CREATE INDEX IF NOT EXISTS idx_api_audit_received_at ON api_audit (received_at DESC);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_api_audit_reason ON api_audit (reason);');

      // Tabla unificada de auditoría y rechazados (persistanceDev)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rejected_messages (
          id UUID PRIMARY KEY,
          idpk TEXT,
          msg_id TEXT,
          type TEXT,
          category TEXT NOT NULL CHECK (category IN ('DUPLICADO', 'DESCARTE', 'NACK')),
          reason TEXT NOT NULL,
          payload JSONB,
          received_at TIMESTAMPTZ NOT NULL,
          seq BIGSERIAL
        );
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_rejected_messages_idpk ON rejected_messages (idpk);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_rejected_messages_seq ON rejected_messages (seq DESC);');
      await pool.query('ALTER TABLE rejected_messages ADD COLUMN IF NOT EXISTS raw_body TEXT;');
      await pool.query('ALTER TABLE rejected_messages ADD COLUMN IF NOT EXISTS routing_key TEXT;');
      await pool.query('ALTER TABLE rejected_messages ADD COLUMN IF NOT EXISTS detail TEXT;');
      await pool.query('ALTER TABLE rejected_messages ADD COLUMN IF NOT EXISTS code INTEGER;');
      await pool.query(`ALTER TABLE rejected_messages ADD COLUMN IF NOT EXISTS response_status TEXT NOT NULL DEFAULT 'none'
        CHECK (response_status IN ('none', 'pending', 'published'));`);
      await pool.query('ALTER TABLE rejected_messages ADD COLUMN IF NOT EXISTS response_payload JSONB;');

      await ledger.migrate(pool);
      console.log('[master] Conectado a Postgres. Tablas listas.');
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
    const reporter = reportWorker?.health || { enabled: false };
    const negotiator = negotiationWorker?.health || { enabled: false };
    const reporterHealthy = !reporter.enabled || (!reporter.lastError && Date.now() - Date.parse(reporter.lastTick || reporter.startedAt) < 60000);
    const negotiatorHealthy = !negotiator.enabled || (!negotiator.lastError && Date.now() - Date.parse(negotiator.lastTick || negotiator.startedAt) < 60000);
    const healthy = reporterHealthy && negotiatorHealthy;
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'error', uptime: process.uptime(), count: result.rows[0].count, reporter, negotiator });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

async function insertEvent(event) {
  const result = await ledger.recordEvent(pool, event);
  reportWorker?.wake();
  negotiationWorker?.wake();
  return result;
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
      // Registro de duplicado en rejected_messages (flujo persistanceDev)
      await pool.query(
        `INSERT INTO rejected_messages
         (id, idpk, msg_id, type, category, reason, payload, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), idpk, typeof body.msgId === 'string' ? body.msgId : null,
          type, 'DUPLICADO', 'DUPLICATE_IDPK', JSON.stringify(body), receivedAtValue]
      );
      return res.status(200).json({ message: 'Evento ya registrado (idpk duplicado)', idpk, duplicate: true });
    }

    console.log(`[master] Evento almacenado. id=${result.id} idpk=${idpk}`);
    res.status(201).json({ id: result.id, ledgerApplied: result.ledgerApplied });
  } catch (err) {
    console.error('[master] Error al guardar evento:', err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode === 422 ? err.message : 'Error interno al guardar el evento' });
  }
});

// Endpoint unificado de auditoría para recibir NACKs y descartes desde el conector
app.post('/audit', async (req, res) => {
  const body = req.body;
  const discardReasons = new Set(['INVALID_JSON', 'INVALID_ENVELOPE', 'MISSING_MSGID', 'UNEXPECTED_ROUTING_KEY', 'INVALID_RESPONSE']);
  const nackCodes = { MALFORMED_MESSAGE: 422, UNKNOWN_TYPE: 400, IDPK_EQUALS_MSGID: 422, IDENTITY_MISMATCH: 403 };
  
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || !['DESCARTE', 'NACK'].includes(body.category) || typeof body.reason !== 'string'
      || typeof body.rawBody !== 'string' || typeof body.detail !== 'string' || !body.detail.trim()
      || (body.routingKey !== undefined && typeof body.routingKey !== 'string')) {
    return res.status(400).json({ error: 'Registro de auditoria invalido' });
  }
  if (body.category === 'DESCARTE' && !discardReasons.has(body.reason)) {
    return res.status(400).json({ error: 'Motivo de descarte invalido' });
  }
  if (body.category === 'NACK' && (!Object.hasOwn(nackCodes, body.reason) || body.code !== nackCodes[body.reason]
      || !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)
      || !Object.hasOwn(body.payload, 'msgId'))) {
    return res.status(400).json({ error: 'Registro NACK requiere reason/code validos y el mensaje rechazado con msgId' });
  }
  
  const receivedAt = body.receivedAt ?? new Date().toISOString();
  if (typeof receivedAt !== 'string' || !Number.isFinite(Date.parse(receivedAt))) {
    return res.status(400).json({ error: 'receivedAt debe ser una fecha valida' });
  }
  
  const payload = body.payload ?? null;
  const id = randomUUID();
  try {
    await pool.query(
      `INSERT INTO rejected_messages
       (id, idpk, msg_id, type, category, reason, payload, received_at, raw_body, routing_key, detail, code, response_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, typeof payload?.idpk === 'string' ? payload.idpk : null,
        typeof payload?.msgId === 'string' ? payload.msgId : null,
        typeof payload?.type === 'string' ? payload.type : null,
        body.category, body.reason, JSON.stringify(payload), receivedAt,
        body.rawBody, body.routingKey ?? null, body.detail,
        body.category === 'NACK' ? body.code : null, body.category === 'NACK' ? 'pending' : 'none']
    );
    res.status(201).json({ id });
  } catch (err) {
    console.error('[master] Error al guardar auditoria:', err.message);
    res.status(500).json({ error: 'Error interno al guardar la auditoria' });
  }
});

app.patch('/audit/:id/response', async (req, res) => {
  const response = req.body?.response;
  const isUuid = value => typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const nackCodes = { MALFORMED_MESSAGE: 422, UNKNOWN_TYPE: 400, IDPK_EQUALS_MSGID: 422, IDENTITY_MISMATCH: 403 };
  
  if (!isUuid(req.params.id) || !response || response.type !== 'nack' || response.cityId !== 'REE'
      || !isUuid(response.msgId) || !isUuid(response.idpk) || response.msgId.toLowerCase() === response.idpk.toLowerCase()
      || typeof response.reason !== 'string' || !Object.hasOwn(nackCodes, response.reason)
      || response.code !== nackCodes[response.reason] || !response.data
      || !Object.hasOwn(response.data, 'target') || typeof response.data.message !== 'string'
      || !response.data.message.trim()) {
    return res.status(400).json({ error: 'Respuesta NACK invalida' });
  }
  try {
    const result = await pool.query(
      `UPDATE rejected_messages SET response_status = 'published', response_payload = $2::jsonb
       WHERE id = $1 AND category = 'NACK' AND reason = $3 AND code = $4
         AND payload->'msgId' = $5::jsonb AND detail = $6
         AND (response_status = 'pending' OR response_payload = $2::jsonb)
       RETURNING id`,
      [req.params.id, JSON.stringify(response), response.reason, response.code,
        JSON.stringify(response.data.target), response.data.message]
    );
    if (result.rowCount === 0) {
      const exists = await pool.query('SELECT id FROM rejected_messages WHERE id = $1', [req.params.id]);
      return res.status(exists.rowCount ? 409 : 404).json({ error: 'Registro no encontrado o respuesta no corresponde al NACK registrado' });
    }
    res.json({ id: req.params.id, responseStatus: 'published' });
  } catch (err) {
    console.error('[master] Error al registrar publicacion NACK:', err.message);
    res.status(500).json({ error: 'Error interno al registrar la publicacion NACK' });
  }
});

// GET Audit ahora expone el flujo enriquecido de persistanceDev
app.get('/audit', authenticate, async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), MAX_PAGE_LIMIT);
  const offset = (page - 1) * limit;

  const filters = { category: 'category', idpk: 'idpk', msgId: 'msg_id', type: 'type', reason: 'reason', responseStatus: 'response_status' };
  const clauses = [];
  const values = [];
  
  for (const [key, column] of Object.entries(filters)) {
    const value = req.query[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      return res.status(400).json({ error: `${key} debe ser un texto` });
    }
    values.push(value);
    clauses.push(`${column} = $${values.length}`);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM rejected_messages ${whereSql}`, values
    );
    const total = countResult.rows[0].total;
    const result = await pool.query(
      `SELECT id, idpk, msg_id AS "msgId", type, category, reason, code, detail,
              payload, raw_body AS "rawBody", routing_key AS "routingKey", received_at AS "receivedAt",
              response_status AS "responseStatus", response_payload AS "responsePayload"
       FROM rejected_messages
       ${whereSql}
       ORDER BY seq DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );
    res.json({ page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1), data: result.rows });
  } catch (err) {
    console.error('[master] Error al consultar /audit:', err.message);
    res.status(500).json({ error: 'Error interno al consultar la auditoria' });
  }
});

app.get('/cycles/:cycleId/report', authenticate, async (req, res) => {
  try {
    const report = await reports.getReport(pool, req.params.cycleId);
    if (!report) return res.status(404).json({ error: 'Ciclo sin reporte programado' });
    res.json(report);
  } catch (err) {
    console.error('[master] Error al consultar reporte:', err.message);
    res.status(500).json({ error: 'Error al consultar reporte' });
  }
});

app.get('/cycles/:cycleId/ledger', authenticate, async (req, res) => {
  try {
    const state = await ledger.getCycleState(pool, req.params.cycleId);
    if (!state) return res.status(404).json({ error: 'Ciclo sin operaciones de ledger' });
    res.json({ ...state, scope: 'status-transfers-and-demands', historicalBaseline: 'zero-at-ledger-installation' });
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
  try {
    const job = await negotiations.createProposal(pool, { cycleId, direction, quantity, pricePerEnergy });
    negotiationWorker?.wake();
    return res.status(201).json(job);
  } catch (err) {
    console.error('[master] Error al crear propuesta:', err.message);
    return res.status(400).json({ error: err.message });
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

app.get('/distance-table', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, idpk, type, package_body AS "data", received_at AS "receivedAt"
       FROM events
       WHERE type = 'distance-table'
         AND jsonb_typeof(package_body->'distances') = 'object'
       ORDER BY seq DESC
       LIMIT 1`
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'No hay una distance-table vigente registrada' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[master] Error al consultar /distance-table:', err.message);
    res.status(500).json({ error: 'Error interno al consultar la distance-table vigente' });
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
  try {
    const data = await negotiations.getNegotiations(pool, {
      cycleId: req.query.cycleId,
      limit: req.query.limit,
    });
    res.json({ data });
  } catch (err) {
    console.error('[master] Error al consultar /negotiations:', err.message);
    res.status(500).json({ error: 'Error interno al consultar negociaciones' });
  }
});

initDb().then(() => {
  reportWorker = reports.startWorker(pool, async envelope => {
    const response = await fetch(`${CONNECTOR_URL}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Publicacion de reporte: HTTP ${response.status}`);
    const published = await response.json();
    if (published.msgId !== envelope.msgId || published.idpk !== envelope.idpk) throw new Error('Connector no preservo IDs del reporte');
  }, { enabled: REPORTS_ENABLED });

  negotiationWorker = negotiations.startWorker(pool, async envelope => {
    const response = await fetch(`${CONNECTOR_URL}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Publicacion de negociacion: HTTP ${response.status}`);
    const published = await response.json();
    if (published.msgId !== envelope.msgId || published.idpk !== envelope.idpk) throw new Error('Connector no preservo IDs de la negociacion');
  }, { enabled: true });

  app.listen(PORT, () => {
    console.log(`[master] Escuchando en http://localhost:${PORT}`);
  });
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(422).json({ reason: 'MALFORMED_MESSAGE' });
  }
  console.error('[master]', err.message);
  res.status(500).json({ error: 'Error interno' });
});