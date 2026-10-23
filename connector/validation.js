const {
  isUuid, isTimestamp, isObject, isKnownType, isCityCode, validateContent,
  PEER_TYPES, MARKET_TYPES,
} = require('./content-validation');

const OWN_CITY = process.env.CITY_ID || 'REE';
const malformed = (message) => ({ reason: 'MALFORMED_MESSAGE', code: 422, message });
const identityMismatch = (message) => ({ reason: 'IDENTITY_MISMATCH', code: 403, message });

function cityFromUserId(userId) {
  const match = typeof userId === 'string' ? userId.match(/^city\.([A-Z]{3})$/) : null;
  return match ? match[1] : null;
}

function validateEnvelope(event, { userId } = {}) {
  for (const field of ['msgId', 'idpk']) {
    if (!isUuid(event[field])) return malformed(`${field} debe ser un UUID valido.`);
  }
  if (typeof event.type !== 'string' || !event.type.trim()) return malformed('type debe ser un texto no vacio.');
  if (!isTimestamp(event.timestamp)) return malformed('timestamp debe ser una fecha ISO 8601 valida.');
  if (!isObject(event.data)) return malformed('data debe ser un objeto JSON.');
  if (event.idpk.toLowerCase() === event.msgId.toLowerCase()) {
    return { reason: 'IDPK_EQUALS_MSGID', code: 422, message: 'idpk debe diferir de msgId.' };
  }
  if (!isKnownType(event.type)) return { reason: 'UNKNOWN_TYPE', code: 400, message: 'El tipo de mensaje no existe en el protocolo.' };

  const senderCity = cityFromUserId(userId);

  if (event.sender === 'central') {
    if (senderCity) return identityMismatch(`user_id ${userId} no corresponde a la central.`);
    if (MARKET_TYPES.has(event.type)) return malformed(`${event.type} viaja por la cola de mercado, no por city.${OWN_CITY}.`);
    return validateContent(event);
  }

  if (isCityCode(event.cityId)) {
    if (!PEER_TYPES.has(event.type)) return malformed(`Una ciudad no puede enviar ${event.type}.`);
    if (senderCity !== event.cityId) {
      return identityMismatch(`user_id ${userId ?? '(ausente)'} no corresponde al cityId ${event.cityId}.`);
    }
    if (event.cityId === OWN_CITY) return malformed('Mensaje de una ciudad hacia sí misma.');
    return validateContent(event);
  }

  return malformed('Se requiere sender central o un cityId de ciudad.');
}

function validateMarketMessage(event, { routingKey } = {}) {
  if (!isObject(event)) return malformed('El mensaje no es un objeto JSON.');
  if (typeof event.type !== 'string' || !MARKET_TYPES.has(event.type)) {
    return { reason: 'UNKNOWN_TYPE', code: 400, message: `Tipo ${event.type} no esperado en el feed de mercado.` };
  }
  if (event.type === 'market-closed') {
    if (routingKey !== 'market.closed' || event.sender !== 'central') return malformed('market-closed debe venir de la central con routing key market.closed.');
  } else {
    const match = typeof routingKey === 'string' ? routingKey.match(/^market\.offer\.([A-Z]{3})$/) : null;
    if (!match) return malformed(`Routing key inesperada en el feed: ${routingKey}.`);
    if (event.cityId !== match[1]) return identityMismatch(`La oferta dice venir de ${event.cityId} pero la publicó ${match[1]}.`);
  }
  return validateContent(event);
}

module.exports = { validateEnvelope, validateMarketMessage, cityFromUserId };
