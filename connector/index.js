require('dotenv').config();
const telemetry = require('./telemetry');
const fs = require('node:fs');
const amqp = require('amqplib');
const http = require('node:http');
const { createPublisher, destinationFor } = require('./publisher');
const { validateEnvelope, validateMarketMessage, cityFromUserId } = require('./validation');
const RESPONSE_TYPES = new Set(['ack', 'nack', 'error', 'bid-rejected']);

const {
  RABBIT_URL,
  RABBIT_HOST = 'broker.iic2173.org',
  RABBIT_PORT = '5671',
  RABBIT_USER,
  RABBIT_PASS,
  RABBIT_VHOST = '',
  RABBIT_QUEUE,
  RABBIT_MARKET_QUEUE,
  MARKET_PREFETCH = '20',
  MASTER_URL = 'http://localhost:3000/events',
  AUDIT_URL = new URL('audit', MASTER_URL).toString(),
  MARKET_URL = new URL('market', MASTER_URL).toString(),
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

if (!RABBIT_MARKET_QUEUE) {
  console.warn('[connector] Falta RABBIT_MARKET_QUEUE (ej: market.REE): no se consumirá el feed de mercado.');
}

function replyRoutingKey(event, userId) {
  if (event && event.sender === 'central') return 'central';
  const city = cityFromUserId(userId);
  return city ? `city.${city}` : null;
}

const RECONNECT_DELAY_MS = 5000;
const MASTER_RETRY_DELAY_MS = 3000;

const HEALTH_FILE = process.env.HEALTH_FILE || '/tmp/connector-healthy';
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_NOT_CONSUMING_MS = Number(process.env.MAX_NOT_CONSUMING_MS || 120_000);

let consuming = false;
let lastConsumingAt = Date.now();

function setConsuming(value) {
  consuming = value;
  if (value) lastConsumingAt = Date.now();
}

function writeHeartbeat() {
  if (consuming) {
    lastConsumingAt = Date.now();
    try {
      fs.writeFileSync(HEALTH_FILE, new Date(lastConsumingAt).toISOString());
    } catch (err) {
      console.error('[connector] No se pudo escribir el heartbeat:', err.message);
    }
    return;
  }
  const idleMs = Date.now() - lastConsumingAt;
  if (idleMs > MAX_NOT_CONSUMING_MS) {
    console.error(
      `[connector] ${Math.round(idleMs / 1000)}s sin consumir la cola; se termina el proceso para que Docker lo reinicie.`
    );
    process.exit(1);
  }
}

setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS).unref();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildUrl() {
  if (RABBIT_URL) return RABBIT_URL;

  const vhost = RABBIT_VHOST ? `/${encodeURIComponent(RABBIT_VHOST)}` : '';
  return `amqps://${encodeURIComponent(RABBIT_USER)}:${encodeURIComponent(
    RABBIT_PASS
  )}@${RABBIT_HOST}:${RABBIT_PORT}${vhost}`;
}

async function recordAudit(entry) {
  const response = await fetch(AUDIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`master respondio ${response.status} al registrar auditoria`);
  return response.json();
}

async function discardMessage(channel, msg, entry) {
  try {
    await recordAudit({ category: 'DESCARTE', ...entry });
    channel.nack(msg, false, false);
    return 'discard';
  } catch (err) {
    console.error('[connector] No se pudo registrar el descarte, se reencola:', err.message);
    await sleep(MASTER_RETRY_DELAY_MS);
    channel.nack(msg, false, true);
    return 'requeue';
  }
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
    telemetry.recordBroker('connect-failed', err.message);
    console.log(`[connector] Reintentando en ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(main, RECONNECT_DELAY_MS);
    return;
  }

  telemetry.recordBroker('connected');

  connection.on('error', (err) => {
    setConsuming(false);
    telemetry.recordBroker('error', err.message);
    console.error('[connector] Error de conexión:', err.message);
  });

  connection.on('close', () => {
    setConsuming(false);
    telemetry.recordBroker('closed');
    console.warn('[connector] Conexión cerrada. Reintentando en ' + RECONNECT_DELAY_MS / 1000 + 's...');
    setTimeout(main, RECONNECT_DELAY_MS);
  });

  const channel = await connection.createChannel();
  channel.on('error', (err) => {
    setConsuming(false);
    console.error('[connector] Error del canal:', err.message);
  });
  channel.on('close', () => {
    setConsuming(false);
    console.warn('[connector] Canal cerrado.');
  });
  await channel.prefetch(1);
  const rawPublish = await createPublisher(connection);

  const publishMessage = async (body, routingKey) => {
    const started = Date.now();
    let exchange = 'desconocido';
    let key = routingKey ?? null;
    try {
      ({ exchange, routingKey: key } = destinationFor(body?.type, routingKey));
    } catch { /* lo rechaza rawPublish con su propio mensaje */ }
    try {
      const message = await rawPublish(body, routingKey);
      telemetry.recordPublish({ exchange, routingKey: key, type: body?.type, outcome: 'ok', durationMs: Date.now() - started });
      return message;
    } catch (err) {
      telemetry.recordPublish({ exchange, routingKey: key, type: body?.type, outcome: 'error', durationMs: Date.now() - started });
      throw err;
    }
  };

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
      const message = await publishMessage(body, body.routingKey);
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

  await channel.consume(
    RABBIT_QUEUE,
    telemetry.consumer(RABBIT_QUEUE, async (msg, info) => {
      if (msg === null) return;

      const receivedAt = new Date().toISOString();
      const raw = msg.content.toString('utf8');
      const routingKey = msg.fields?.routingKey;
      const userId = msg.properties?.userId;
      const replyTo = replyRoutingKey(null, userId);

      if (!['city.REE', 'city.broadcast'].includes(routingKey)) {
        const detail = `Routing key inesperada: ${JSON.stringify(routingKey)}`;
        console.error(`[connector] ${detail}`);
        info.attrs.reason = 'UNEXPECTED_ROUTING_KEY';
        return discardMessage(channel, msg, {
          reason: 'UNEXPECTED_ROUTING_KEY', detail, rawBody: raw, routingKey, receivedAt,
        });
      }
      const delivery = routingKey === 'city.broadcast' ? 'broadcast' : 'direct';

      let event;
      try {
        event = JSON.parse(raw);
      } catch (err) {
        console.error('[connector] No se pudo parsear el mensaje, se descarta:', err.message);
        info.attrs.reason = 'INVALID_JSON';
        return discardMessage(channel, msg, {
          reason: 'INVALID_JSON', detail: err.message, rawBody: raw, routingKey, receivedAt,
        });
      }

      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        const detail = 'El mensaje no es un objeto JSON.';
        console.error(`[connector] ${detail}`);
        info.attrs.reason = 'INVALID_ENVELOPE';
        return discardMessage(channel, msg, {
          reason: 'INVALID_ENVELOPE', detail, payload: event, rawBody: raw, routingKey, receivedAt,
        });
      }

      if (!Object.hasOwn(event, "msgId")) {
        const detail = 'El mensaje no incluye msgId.';
        console.error(`[connector] ${detail}`);
        info.attrs.reason = 'MISSING_MSGID';
        return discardMessage(channel, msg, {
          reason: 'MISSING_MSGID', detail, payload: event, rawBody: raw, routingKey, receivedAt,
        });
      }

      info.attrs = {
        type: typeof event.type === 'string' ? event.type : null,
        cityId: cityFromUserId(userId) || (typeof event.cityId === 'string' ? event.cityId : null),
        cycleId: typeof event.cycleId === 'string' ? event.cycleId : null,
        timestamp: event.timestamp,
      };

      try {
        const invalid = validateEnvelope(event, { userId });
        const respondTo = replyRoutingKey(event, userId) ?? replyTo;
        if (invalid) {
          info.attrs.reason = invalid.reason;
          console.error(`[connector] Mensaje rechazado: ${invalid.reason} msgId=${JSON.stringify(event.msgId)}: ${invalid.message}`);
          if (RESPONSE_TYPES.has(event.type)) {
            return discardMessage(channel, msg, {
              reason: 'INVALID_RESPONSE', detail: invalid.message, payload: event,
              rawBody: raw, routingKey, receivedAt,
            });
          }
          const audit = await recordAudit({
            category: 'NACK', reason: invalid.reason, code: invalid.code,
            detail: invalid.message, payload: event, rawBody: raw, routingKey, receivedAt,
          });
          if (!respondTo) {
            console.warn(`[connector] NACK sin destinatario (user_id ${JSON.stringify(userId)}); solo se registra.`);
            channel.ack(msg);
            return 'nack';
          }
          const data = { target: event.msgId, message: invalid.message };
          if (typeof event.cycleId === 'string' && event.cycleId.length <= 64) data.cycleId = event.cycleId;
          const nack = await publishMessage({
            type: 'nack', reason: invalid.reason, code: invalid.code, data,
          }, respondTo);
          const response = await fetch(`${AUDIT_URL}/${audit.id}/response`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response: nack }),
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error(`master respondio ${response.status} al registrar publicacion NACK`);
          channel.ack(msg);
          return 'nack';
        }

        console.log(`[connector] Evento recibido idpk=${event.idpk} type=${event.type}`);

        const response = await fetch(MASTER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...event, receivedAt, routingKey, delivery, userId }),
        });

        if (!response.ok) {
          throw new Error(`master respondió ${response.status}`);
        }

        console.log(`[connector] Enviado a master OK (idpk=${event.idpk})`);
        if (!RESPONSE_TYPES.has(event.type)) {
          await publishMessage({ type: 'ack', data: { target: event.msgId } }, respondTo);
        }

        channel.ack(msg);
        return 'ack';
      } catch (err) {
        console.error('[connector] No se pudo procesar el mensaje o publicar su respuesta, se reencola:', err.message);
        info.attrs.reason = err.message.slice(0, 200);

        await sleep(MASTER_RETRY_DELAY_MS);
        channel.nack(msg, false, true);
        return 'requeue';
      }
    }),
    { noAck: false }
  );

  if (RABBIT_MARKET_QUEUE) await consumeMarket(connection);

  const stopDepthPoller = telemetry.startQueueDepthPoller(
    connection, [RABBIT_QUEUE, RABBIT_MARKET_QUEUE].filter(Boolean)
  );
  connection.on('close', stopDepthPoller);

  setConsuming(true);
  writeHeartbeat();
}

async function consumeMarket(connection) {
  const marketChannel = await connection.createChannel();
  marketChannel.on('error', (err) => {
    setConsuming(false);
    console.error('[connector] Error del canal de mercado:', err.message);
  });
  marketChannel.on('close', () => {
    setConsuming(false);
    console.warn('[connector] Canal de mercado cerrado.');
  });
  await marketChannel.prefetch(Number(MARKET_PREFETCH) || 20);
  console.log(`[connector] Escuchando la cola de mercado "${RABBIT_MARKET_QUEUE}"...`);

  await marketChannel.consume(
    RABBIT_MARKET_QUEUE,
    telemetry.consumer(RABBIT_MARKET_QUEUE, async (msg, info) => {
      if (msg === null) return;
      const receivedAt = new Date().toISOString();
      const raw = msg.content.toString('utf8');
      const routingKey = msg.fields?.routingKey;

      let event;
      try {
        event = JSON.parse(raw);
      } catch (err) {
        info.attrs.reason = 'INVALID_JSON';
        return discardMessage(marketChannel, msg, {
          reason: 'INVALID_JSON', detail: `Feed de mercado: ${err.message}`, rawBody: raw, routingKey, receivedAt,
        });
      }

      if (event && typeof event === 'object') {
        info.attrs = {
          type: typeof event.type === 'string' ? event.type : null,
          cityId: typeof event.cityId === 'string' ? event.cityId : null,
          cycleId: typeof event.cycleId === 'string' ? event.cycleId : null,
          timestamp: event.timestamp,
        };
      }

      const invalid = validateMarketMessage(event, { routingKey });
      if (invalid) {
        console.error(`[connector] Mensaje de mercado descartado: ${invalid.reason}: ${invalid.message}`);
        info.attrs.reason = invalid.reason;
        return discardMessage(marketChannel, msg, {
          reason: 'INVALID_ENVELOPE', detail: `Feed de mercado (${invalid.reason}): ${invalid.message}`,
          payload: event, rawBody: raw, routingKey, receivedAt,
        });
      }

      try {
        const response = await fetch(MARKET_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...event, receivedAt, routingKey }),
          signal: AbortSignal.timeout(10000),
        });
        if (response.status >= 400 && response.status < 500) {
          console.error(`[connector] master rechazó el mensaje de mercado (${response.status}); se descarta.`);
          info.attrs.reason = `MASTER_${response.status}`;
          marketChannel.ack(msg);
          return 'rejected';
        }
        if (!response.ok) throw new Error(`master respondió ${response.status}`);
        marketChannel.ack(msg);
        return 'ack';
      } catch (err) {
        console.error('[connector] No se pudo entregar el mensaje de mercado, se reencola:', err.message);
        info.attrs.reason = err.message.slice(0, 200);
        await sleep(MASTER_RETRY_DELAY_MS);
        marketChannel.nack(msg, false, true);
        return 'requeue';
      }
    }),
    { noAck: false }
  );
}

main().catch((err) => {
  console.error('[connector] Error inesperado:', err);
  setTimeout(main, RECONNECT_DELAY_MS);
});