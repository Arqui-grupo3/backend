const { randomUUID } = require('node:crypto');
const { isUuid, isTimestamp, validateContent } = require('./content-validation');

async function createPublisher(connection) {
  const channel = await connection.createConfirmChannel();
  channel.on('error', (err) => {
    console.error('[publisher] Error de canal:', err.message);
  });

  return async function publishMessage(
    { type, data = {}, idpk = randomUUID(), msgId = randomUUID(), timestamp = new Date().toISOString(), cycleId, reason, code },
    routingKey = 'central'
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
      cityId: 'REE',
      data,
    };
    if (cycleId !== undefined) message.cycleId = cycleId;
    if (reason !== undefined) message.reason = reason;
    if (code !== undefined) message.code = code;

    const invalid = validateContent(message);
    if (invalid) throw new Error(`${invalid.reason}: ${invalid.message}`);

    await new Promise((resolve, reject) => {
      channel.publish(
        'energy.x',
        routingKey,
        Buffer.from(JSON.stringify(message)),
        { contentType: 'application/json', persistent: true, userId: 'city.REE' },
        (err) => (err ? reject(err) : resolve())
      );
    });

    return message;
  };
}

module.exports = { createPublisher };
