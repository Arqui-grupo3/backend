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

  const { idpk, type, packageBody, receivedAt } = body;

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
      [id, idpk, type, packageBody ?? null, receivedAtValue]
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
      `SELECT id, idpk, type, package_body AS "packageBody", received_at AS "receivedAt"
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
      `SELECT id, idpk, type, package_body AS "packageBody", received_at AS "receivedAt"
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
