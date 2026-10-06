const { isUuid, isTimestamp, isObject, isKnownType, validateContent } = require('./content-validation');

function validateEnvelope(event) {
  const malformed = (message) => ({ reason: 'MALFORMED_MESSAGE', code: 422, message });
  for (const field of ['msgId', 'idpk']) {
    if (!isUuid(event[field])) return malformed(`${field} debe ser un UUID valido.`);
  }
  if (typeof event.type !== 'string' || !event.type.trim()) return malformed('type debe ser un texto no vacio.');
  if (!isTimestamp(event.timestamp)) return malformed('timestamp debe ser una fecha ISO 8601 valida.');
  if (!isObject(event.data)) return malformed('data debe ser un objeto JSON.');
  if (event.idpk.toLowerCase() === event.msgId.toLowerCase()) {
    return { reason: 'IDPK_EQUALS_MSGID', code: 422, message: 'idpk debe diferir de msgId.' };
  }
  if (!isKnownType(event.type)) return { reason: 'UNKNOWN_TYPE', code: 400, message: 'El tipo de mensaje no existe en E1.' };
  if (event.sender !== 'central') return malformed('sender debe ser central en mensajes recibidos.');
  return validateContent(event);
}

module.exports = { validateEnvelope };
