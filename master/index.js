require('dotenv').config();
const express = require('express');
const { randomUUID } = require('crypto');
const { Client } = require('pg');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

const events = [];
const db = new Client();
db.on('error', (err) => {
  console.error('[master] Error de PostgreSQL:', err.message);
  process.exit(1);
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), count: events.length });
});

app.post('/events', async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body invalido, se esperaba JSON' });
  }

  const { idpk, type, data, receivedAt } = body;

  if (!idpk || !type) {
    return res.status(400).json({ error: 'Faltan campos requeridos: idpk, type' });
  }

  const alreadyExists = events.some((ev) => ev.idpk === idpk);
  if (alreadyExists) {
    return res.status(200).json({ message: 'Evento ya registrado (idpk duplicado)', idpk });
  }

  const record = {
    id: randomUUID(),
    idpk,
    type,
    msgId: body.msgId,
    timestamp: body.timestamp,
    cycleId: body.cycleId,
    sender: body.sender,
    cityId: body.cityId,
    reason: body.reason,
    code: body.code,
    data: data ?? null,
    routingKey: body.routingKey,
    delivery: body.delivery,
    receivedAt: receivedAt || new Date().toISOString(),
  };

  try {
    const result = await db.query(
      `INSERT INTO events (id, idpk, type, package_body, received_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idpk) DO NOTHING RETURNING id`,
      [record.id, idpk, type, record, record.receivedAt]
    );
    if (result.rowCount === 0) {
      return res.status(200).json({ message: 'Evento ya registrado (idpk duplicado)', idpk });
    }
  } catch (err) {
    console.error('[master] Error al guardar evento:', err.message);
    return res.status(500).json({ error: 'Error interno al guardar el evento' });
  }

  events.push({ ...record, packageBody: record });

  console.log(`[master] Evento almacenado. id=${record.id} idpk=${record.idpk} total=${events.length}`);

  res.status(201).json({ id: record.id });
});

app.get('/history', (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.max(parseInt(req.query.limit, 10) || 25, 1);

  const reserved = new Set(['page', 'limit']);
  const filters = Object.entries(req.query).filter(([key]) => !reserved.has(key));

  let filtered = events;

  for (const [key, value] of filters) {
    filtered = filtered.filter((ev) => {
      if (!(key in ev)) return false;

      const fieldValue = ev[key];

      if (typeof fieldValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
        return fieldValue.startsWith(String(value));
      }

      return String(fieldValue) === String(value);
    });
  }

  const total = filtered.length;
  const totalPages = Math.max(Math.ceil(total / limit), 1);
  const start = (page - 1) * limit;
  const data = filtered.slice(start, start + limit);

  res.json({ page, limit, total, totalPages, data });
});

app.get('/history/:id', (req, res) => {
  const record = events.find((ev) => ev.id === req.params.id);

  if (!record) {
    return res.status(404).json({ error: 'Registro no encontrado' });
  }

  res.json(record);
});

db.connect().then(async () => {
  const result = await db.query('SELECT id, idpk, type, package_body, received_at FROM events ORDER BY received_at ASC, id ASC');
  for (const row of result.rows) {
    events.push({
      ...row.package_body,
      id: row.id,
      idpk: row.idpk,
      type: row.type,
      packageBody: row.package_body,
      receivedAt: row.package_body?.receivedAt || new Date(row.received_at).toISOString(),
    });
  }
  app.listen(PORT, () => {
    console.log(`[master] Escuchando en http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('[master] No se pudo iniciar PostgreSQL:', err.message);
  process.exit(1);
});
