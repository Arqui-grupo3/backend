require('newrelic');
require('dotenv').config();
const express = require('express');
const { createPublicKey, randomUUID, verify } = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === 'true';
const AUTH0_ISSUER = process.env.AUTH0_ISSUER;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;
const AUTH0_JWKS_URL = process.env.AUTH0_JWKS_URL || (AUTH0_ISSUER ? `${AUTH0_ISSUER.replace(/\/$/, '')}/.well-known/jwks.json` : null);
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
    if (claims.iss !== AUTH0_ISSUER || claims.aud !== AUTH0_AUDIENCE || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) {
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
      await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS msg_id UUID;');
      await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS cycle_id TEXT;');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_events_seq ON events (seq);');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_events_cycle_id ON events (cycle_id);');
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

app.post('/events', async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body invalido, se esperaba JSON' });
  }

  const { idpk, msgId, type, data, cycleId, receivedAt } = body;

  if (!idpk || !type) {
    return res.status(400).json({ error: 'Faltan campos requeridos: idpk, type' });
  }

  const id = randomUUID();
  const receivedAtValue = receivedAt || new Date().toISOString();

  try {
    const result = await pool.query(
      `INSERT INTO events (id, idpk, msg_id, type, cycle_id, package_body, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idpk) DO NOTHING
       RETURNING id`,
      [id, idpk, msgId ?? null, type, cycleId ?? null, data ?? body, receivedAtValue]
    );

    if (result.rowCount === 0) {
      return res.status(200).json({ message: 'Evento ya registrado (idpk duplicado)', idpk });
    }

    console.log(`[master] Evento almacenado. id=${id} idpk=${idpk}`);
    res.status(201).json({ id });
  } catch (err) {
    console.error('[master] Error al guardar evento:', err.message);
    res.status(500).json({ error: 'Error interno al guardar el evento' });
  }
});

app.get('/history', authenticate, async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.max(parseInt(req.query.limit, 10) || 25, 1);

  const allowedColumns = {
    id: 'id', idpk: 'idpk', msgId: 'msg_id', type: 'type', cycleId: 'cycle_id', receivedAt: 'received_at',
  };
  const reserved = new Set(['page', 'limit']);

  const whereClauses = [];
  const values = [];

  for (const [key, value] of Object.entries(req.query)) {
    if (reserved.has(key)) continue;
    const column = allowedColumns[key];
    if (!column) continue;

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
              package_body AS data, received_at AS "receivedAt"
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
              package_body AS data, received_at AS "receivedAt"
       FROM events
       WHERE type IN ('negotiation-proposal', 'give', 'take', 'transfer', 'error')
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
