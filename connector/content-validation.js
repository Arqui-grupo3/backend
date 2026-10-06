const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MESSAGE_TYPES = new Set([
  'request', 'ack', 'nack', 'error', 'status-statement', 'transfer',
  'distance-table', 'demand-statement', 'negotiation-proposal',
  'give', 'take', 'negotiation-report',
]);
const CYCLE_TYPES = new Set([
  'status-statement', 'transfer', 'demand-statement', 'negotiation-proposal',
  'give', 'take', 'negotiation-report', 'error',
]);
const NACK_CODES = { MALFORMED_MESSAGE: 422, UNKNOWN_TYPE: 400, IDPK_EQUALS_MSGID: 422, IDENTITY_MISMATCH: 403 };
const ERROR_CODES = { CYCLE_UNKNOWN: [404], CYCLE_EXPIRED: [410], PRICE_ABOVE_CAP: [422], OVER_CAPACITY: [409], REPORT_TOO_EARLY: [422, 425] };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && Boolean(value.trim());
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isNonnegative = (value) => isNumber(value) && value >= 0;
const isPositive = (value) => isNumber(value) && value > 0;
const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);
const isKnownType = (type) => MESSAGE_TYPES.has(type);

function isTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const localTime = new Date(`${value.slice(0, 19)}Z`);
  return Number.isFinite(localTime.getTime()) && localTime.toISOString().slice(0, 19) === value.slice(0, 19);
}

function validateContent(event) {
  const invalid = (message) => ({ reason: 'MALFORMED_MESSAGE', code: 422, message });
  const { type, data } = event;
  if (!isKnownType(type)) return { reason: 'UNKNOWN_TYPE', code: 400, message: 'El tipo de mensaje no existe en E1.' };
  if (!isObject(data)) return invalid('data debe ser un objeto JSON.');
  if (CYCLE_TYPES.has(type) && !isText(event.cycleId)) return invalid(`${type} requiere un cycleId no vacio.`);

  switch (type) {
    case 'status-statement':
      if (!isObject(data.energy)) return invalid('data.energy debe ser un objeto.');
      for (const field of ['generationCapacity', 'consumption', 'generationCost']) {
        if (!isNonnegative(data.energy[field])) return invalid(`data.energy.${field} debe ser un numero finito no negativo.`);
      }
      if (!isTimestamp(data.validUntil)) return invalid('data.validUntil debe ser una fecha ISO 8601 valida.');
      break;
    case 'transfer':
      if (!isNumber(data.quantity)) return invalid('transfer requiere data.quantity como numero finito.');
      if (Object.hasOwn(data, 'becauseOf') && !isUuid(data.becauseOf)) return invalid('data.becauseOf debe ser el UUID de la confirmacion.');
      break;
    case 'demand-statement':
      if (!isObject(data.balance)) return invalid('data.balance debe ser un objeto.');
      if (!isNumber(data.balance.quantity)) return invalid('data.balance.quantity debe ser un numero finito, positivo o negativo.');
      if (!isNonnegative(data.balance.valuePerKwh)) return invalid('data.balance.valuePerKwh debe ser un numero finito no negativo.');
      break;
    case 'distance-table':
      if (!isObject(data.distances)) return invalid('data.distances debe ser un objeto.');
      for (const [destination, route] of Object.entries(data.distances)) {
        if (!isText(destination) || !isObject(route)) return invalid('Cada destino debe tener una ruta valida.');
        if (!isNonnegative(route.distance) || !isNonnegative(route.transportCost) || typeof route.enabled !== 'boolean') {
          return invalid(`Ruta ${destination}: distance y transportCost deben ser numeros no negativos; enabled debe ser booleano.`);
        }
      }
      break;
    case 'give':
    case 'take':
      if (!isUuid(data.target)) return invalid('data.target debe ser el UUID de la propuesta.');
      if (!isPositive(data.energy) || !isNonnegative(data.pricePerEnergy)) return invalid('La confirmacion requiere energy positivo y pricePerEnergy no negativo.');
      break;
    case 'ack':
      if (!isUuid(data.target)) return invalid('data.target debe ser un UUID valido.');
      break;
    case 'nack':
      if (typeof event.reason !== 'string' || !Object.hasOwn(NACK_CODES, event.reason) || event.code !== NACK_CODES[event.reason]) {
        return invalid('NACK requiere una combinacion valida de reason y code.');
      }
      // Un NACK por msgId malformado debe poder devolver ese valor original.
      if (!Object.hasOwn(data, 'target') || (event.reason !== 'MALFORMED_MESSAGE' && !isUuid(data.target))) return invalid('NACK requiere data.target del mensaje rechazado.');
      if (!isText(data.message)) return invalid('NACK requiere data.message no vacio.');
      break;
    case 'error':
      if (typeof event.reason !== 'string' || !Object.hasOwn(ERROR_CODES, event.reason) || !ERROR_CODES[event.reason].includes(event.code)) {
        return invalid('error requiere una combinacion valida de reason y code.');
      }
      if (!isUuid(data.target) || !isText(data.message)) return invalid('error requiere data.target UUID y data.message no vacio.');
      if (event.reason === 'PRICE_ABOVE_CAP' && !isNonnegative(data.cap)) return invalid('PRICE_ABOVE_CAP requiere data.cap no negativo.');
      if (event.reason === 'OVER_CAPACITY' && !isNonnegative(data.spare)) return invalid('OVER_CAPACITY requiere data.spare no negativo.');
      if (event.reason === 'REPORT_TOO_EARLY' && !isTimestamp(data.opensAt)) return invalid('REPORT_TOO_EARLY requiere data.opensAt ISO 8601 valido.');
      break;
    case 'request':
      if (!isText(data.ask)) return invalid('request requiere data.ask no vacio.');
      break;
    case 'negotiation-proposal':
      if (!['give', 'take'].includes(data.direction) || !isPositive(data.quantity) || !isNonnegative(data.pricePerEnergy)) {
        return invalid('La propuesta requiere direction give/take, quantity positivo y pricePerEnergy no negativo.');
      }
      break;
    case 'negotiation-report':
      if (!isNumber(data.budgetBalance) || !isNumber(data.energyBalance)) return invalid('El reporte requiere budgetBalance y energyBalance como numeros finitos.');
      break;
  }
  return null;
}

module.exports = { isUuid, isTimestamp, isObject, isKnownType, validateContent };
