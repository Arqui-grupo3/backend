require('dotenv').config();
const amqp = require('amqplib');
const http = require('node:http');
const { createPublisher } = require('./publisher');
const { validateEnvelope } = require('./validation');
const RESPONSE_TYPES = new Set(['ack', 'nack', 'error']);

const {
  RABBIT_URL,
  RABBIT_HOST = 'broker.iic2173.org',
  RABBIT_PORT = '5671',
  RABBIT_USER,
  RABBIT_PASS,
  RABBIT_VHOST = '',
  RABBIT_QUEUE,
  MASTER_URL = 'http://localhost:3000/events',
  CONNECTOR_CONTROL_PORT = '3001',
} = process.env;

if (!RABBIT_URL && (!RABBIT_USER || !RABBIT_PASS)) {
  console.error(
    'Faltan credenciales. Define RABBIT_URL (URL completa) o RABBIT_USER/RABBIT_PASS ' +
      '(copia .env.example a .env y completa tus datos).'
  );
  process.exit(1);
}

if (!RABBIT_QUEUE) {
  console.error('Falta RABBIT_QUEUE (ej: city.REE.q) en tu .env.');
  process.exit(1);
}

const RECONNECT_DELAY_MS = 5000;
const MASTER_RETRY_DELAY_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function auditUrl() {
  return MASTER_URL.replace(/\/events\/?$/, '/audit');
}

async function reportAudit(entry) {
  try {
    const response = await fetch(auditUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    if (!response.ok) throw new Error(`master respondió ${response.status}`);
  } catch (err) {
    console.error('[connector] No se pudo registrar auditoria:', err.message);
  }
}

function buildUrl() {
  if (RABBIT_URL) return RABBIT_URL;

  const vhost = RABBIT_VHOST ? `/${encodeURIComponent(RABBIT_VHOST)}` : '';
  return `amqps://${encodeURIComponent(RABBIT_USER)}:${encodeURIComponent(
    RABBIT_PASS
  )}@${RABBIT_HOST}:${RABBIT_PORT}${vhost}`;
}

async function main() {
  const url = buildUrl();

  console.log(`[connector] Conectando a ${RABBIT_HOST}:${RABBIT_PORT} ...`);

  let connection;
  try {
    connection = await amqp.connect(url, {
      rejectUnauthorized: true,
    });
  } catch (err) {
    console.error('[connector] Error al conectar:', err.message);
    console.log(`[connector] Reintentando en ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(main, RECONNECT_DELAY_MS);
    return;
  }

  connection.on('error', (err) => {
    console.error('[connector] Error de conexión:', err.message);
  });

  connection.on('close', () => {
    console.warn('[connector] Conexión cerrada. Reintentando en ' + RECONNECT_DELAY_MS / 1000 + 's...');
    setTimeout(main, RECONNECT_DELAY_MS);
  });

  const channel = await connection.createChannel();
  await channel.prefetch(1);
  const publishMessage = await createPublisher(connection);
  const controlServer = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/publish') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
      return;
    }
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const message = await publishMessage(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(message));
    } catch (err) {
      console.error('[connector] Error publicando desde API:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  controlServer.listen(CONNECTOR_CONTROL_PORT, () => {
    console.log(`[connector] API interna de publicación en ${CONNECTOR_CONTROL_PORT}`);
  });
  controlServer.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') console.error('[connector] Error en API interna:', err.message);
  });
  connection.on('close', () => {
    controlServer.close();
  });

  console.log(`[connector] Escuchando la cola "${RABBIT_QUEUE}"...`);

  channel.consume(
    RABBIT_QUEUE,
    async (msg) => {
      if (msg === null) return;

      const routingKey = msg.fields?.routingKey;
      if (!['city.REE', 'city.broadcast'].includes(routingKey)) {
        console.error(`[connector] Routing key inesperada, se descarta: ${JSON.stringify(routingKey)}`);
        await reportAudit({ type: 'unknown', reason: 'DISCARDED', details: { routingKey } });
        channel.nack(msg, false, false);
        return;
      }
      const delivery = routingKey === 'city.broadcast' ? 'broadcast' : 'direct';

      const receivedAt = new Date().toISOString();

      let event;
      try {
        const raw = msg.content.toString('utf8');
        event = JSON.parse(raw);
      } catch (err) {
        console.error('[connector] No se pudo parsear el mensaje, se descarta:', err.message);
        await reportAudit({
          type: 'unknown',
          reason: 'DISCARDED',
          details: { message: 'JSON invalido', error: err.message },
          receivedAt,
        });
        channel.nack(msg, false, false);
        return;
      }

      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        console.error("[connector] El mensaje no es un objeto JSON, se descarta.");
        await reportAudit({ type: 'unknown', reason: 'DISCARDED', details: { message: 'El mensaje no es un objeto JSON' }, receivedAt });
        channel.nack(msg, false, false);
        return;
      }

      if (!Object.hasOwn(event, "msgId")) {
        console.error("[connector] El mensaje no incluye msgId, se descarta.");
        await reportAudit({
          type: typeof event.type === 'string' ? event.type : 'unknown',
          cycleId: event.cycleId ?? null,
          reason: 'DISCARDED',
          details: { message: 'El mensaje no incluye msgId' },
          receivedAt,
        });
        channel.nack(msg, false, false);
        return;
      }

      try {
        const invalid = validateEnvelope(event);
        if (invalid) {
          console.error(`[connector] Mensaje rechazado: ${invalid.reason} msgId=${JSON.stringify(event.msgId)}: ${invalid.message}`);
          await reportAudit({
            idpk: event.idpk ?? null,
            msgId: event.msgId ?? null,
            type: event.type,
            cycleId: event.cycleId ?? null,
            reason: 'NACK',
            details: { nackReason: invalid.reason, code: invalid.code, message: invalid.message },
            receivedAt,
          });
          if (!RESPONSE_TYPES.has(event.type)) {
            const data = { target: event.msgId, message: invalid.message };
            if (Object.hasOwn(event, 'cycleId')) data.cycleId = event.cycleId;
            await publishMessage({
              type: 'nack', reason: invalid.reason, code: invalid.code, data,
            });
          }
          channel.ack(msg);
          return;
        }

        console.log(`[connector] Evento recibido idpk=${event.idpk} type=${event.type}`);

        const response = await fetch(MASTER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...event, receivedAt, routingKey, delivery }),
        });

        if (!response.ok) {
          throw new Error(`master respondió ${response.status}`);
        }

        console.log(`[connector] Enviado a master OK (idpk=${event.idpk})`);
        if (!RESPONSE_TYPES.has(event.type)) {
          await publishMessage({ type: "ack", data: { target: event.msgId } });
        }

        channel.ack(msg);
      } catch (err) {

        console.error('[connector] No se pudo procesar el mensaje o publicar su respuesta, se reencola:', err.message);

        await sleep(MASTER_RETRY_DELAY_MS);
        channel.nack(msg, false, true);
      }
    },
    { noAck: false }
  );
}

main().catch((err) => {
  console.error('[connector] Error inesperado:', err);
  setTimeout(main, RECONNECT_DELAY_MS);
});
