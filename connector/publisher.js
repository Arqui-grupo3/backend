const { randomUUID } = require('node:crypto');
const { isUuid, isTimestamp, validateContent, MARKET_TYPES } = require('./content-validation');

const OWN_CITY = process.env.CITY_ID || 'REE';
const CITY_ROUTING_KEY = /^city\.[A-Z]{3}$/;

function destinationFor(type, routingKey) {
  if (MARKET_TYPES.has(type)) return { exchange: 'market', routingKey: `market.offer.${OWN_CITY}` };
  const key = routingKey ?? 'central';
  if (key !== 'central' && !CITY_ROUTING_KEY.test(key)) throw new Error(`Routing key no permitida: ${key}`);
  if (key === `city.${OWN_CITY}`) throw new Error('No se publica hacia la propia cola.');
  return { exchange: 'energy.x', routingKey: key };
}

async function createPublisher(connection) {
  const channel = await connection.createConfirmChannel();
  channel.on('error', (err) => {
    console.error('[publisher] Error de canal:', err.message);
  });

  return async function publishMessage(
    { type, data = {}, idpk = randomUUID(), msgId = randomUUID(), timestamp = new Date().toISOString(), cycleId, reason, code },
    routingKey
  ) {
    if (typeof type !== 'string' || !type.trim()) {
      throw new Error('La publicacion requiere un type.');
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('data debe ser un objeto JSON.');
    }
    if (!isUuid(idpk)) {
      throw new Error('La publicacion requiere un idpk UUID valido.');
    }

    if (!isUuid(msgId) || msgId.toLowerCase() === idpk.toLowerCase()) throw new Error('msgId debe ser un UUID distinto de idpk.');
    if (!isTimestamp(timestamp)) throw new Error('timestamp invalido.');

    const message = {
      idpk,
      msgId,
      type,
      timestamp,
      cityId: OWN_CITY,
      data,
    };
    if (cycleId !== undefined) message.cycleId = cycleId;
    if (reason !== undefined) message.reason = reason;
    if (code !== undefined) message.code = code;

    const invalid = validateContent(message);
    if (invalid) throw new Error(`${invalid.reason}: ${invalid.message}`);
    const destination = destinationFor(type, routingKey);

    await new Promise((resolve, reject) => {
      channel.publish(
        destination.exchange,
        destination.routingKey,
        Buffer.from(JSON.stringify(message)),
        { contentType: 'application/json', persistent: true, userId: `city.${OWN_CITY}` },
        (err) => (err ? reject(err) : resolve())
      );
    });

    return message;
  };
}

module.exports = { createPublisher, destinationFor };
