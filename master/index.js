require('dotenv').config();
const express = require('express');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

const events = [];

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), count: events.length });
});

app.post('/events', (req, res) => {
  const body = req.body;

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body invalido, se esperaba JSON' });
  }

  const { idpk, type, packageBody, receivedAt } = body;

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
    packageBody: packageBody ?? null,
    receivedAt: receivedAt || new Date().toISOString(),
  };

  events.push(record);

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

app.listen(PORT, () => {
  console.log(`[master] Escuchando en http://localhost:${PORT}`);
});
