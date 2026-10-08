require('dotenv').config();
const express = require('express');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

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
          type TEXT NOT NULL,
          package_body JSONB,
          received_at TIMESTAMPTZ NOT NULL,
          seq BIGSERIAL
        );
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_events_seq ON events (seq);');
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

  const { idpk, type, data, packageBody, receivedAt } = body;

  if (!idpk || !type) {
    return res.status(400).json({ error: 'Faltan campos requeridos: idpk, type' });
  }

  const id = randomUUID();
  const receivedAtValue = receivedAt || new Date().toISOString();

  try {
    const result = await pool.query(
      `INSERT INTO events (id, idpk, type, package_body, received_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idpk) DO NOTHING
       RETURNING id`,
      [id, idpk, type, data ?? packageBody ?? null, receivedAtValue]
    );

    if (result.rowCount === 0) {
      await pool.query(
        `INSERT INTO rejected_messages
         (id, idpk, msg_id, type, category, reason, payload, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), idpk, typeof body.msgId === 'string' ? body.msgId : null,
          type, 'DUPLICADO', 'DUPLICATE_IDPK', JSON.stringify(body), receivedAtValue]
      );
      return res.status(200).json({ message: 'Evento ya registrado (idpk duplicado)', idpk });
    }

    console.log(`[master] Evento almacenado. id=${id} idpk=${idpk}`);
    res.status(201).json({ id });
  } catch (err) {
    console.error('[master] Error al guardar evento:', err.message);
    res.status(500).json({ error: 'Error interno al guardar el evento' });
  }
});

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

app.get('/audit', async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 25);
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit)
      || limit < 1 || limit > 100 || !Number.isSafeInteger(offset)) {
    return res.status(400).json({ error: 'page debe ser un entero positivo y limit un entero entre 1 y 100' });
  }

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

app.get('/distance-table', async (req, res) => {
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

app.get('/history', async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.max(parseInt(req.query.limit, 10) || 25, 1);

  const allowedColumns = { id: 'id', idpk: 'idpk', type: 'type', receivedAt: 'received_at' };
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
      `SELECT id, idpk, type, package_body AS "data", received_at AS "receivedAt"
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

app.get('/history/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, idpk, type, package_body AS "data", received_at AS "receivedAt"
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

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`[master] Escuchando en http://localhost:${PORT}`);
  });
});
