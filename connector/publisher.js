const { randomUUID } = require('node:crypto');
const { isUuid, validateContent } = require('./content-validation');

async function createPublisher(connection) {
  const channel = await connection.createConfirmChannel();
  channel.on('error', (err) => {
    console.error('[publisher] Error de canal:', err.message);
  });

  return async function publishMessage(
    { type, data = {}, idpk = randomUUID(), cycleId, reason, code },
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

    const message = {
      idpk,
      msgId: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      cityId: 'REE',
      data,
    };
    if (cycleId !== undefined) message.cycleId = cycleId;
    if (reason !== undefined) message.reason = reason;
    if (code !== undefined) message.code = code;

    while (message.msgId.toLowerCase() === idpk.toLowerCase()) message.msgId = randomUUID();
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
