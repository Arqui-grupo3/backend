const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const WALLET_EVENT_TYPES = new Set(['swap-proposed', 'swap-settled', 'swap-cancelled', 'swap-expired', 'swap-rejected']);
const CENTRAL_V3_TYPES = new Set(['trade-recorded', 'imbalance-settlement', ...WALLET_EVENT_TYPES]);
const PEER_TYPES = new Set(['bid', 'bid-accepted', 'bid-rejected', 'ack', 'nack']);
const MARKET_TYPES = new Set(['offer', 'offer-updated', 'offer-withdrawn', 'market-closed']);
const MESSAGE_TYPES = new Set([
  'request', 'ack', 'nack', 'error', 'status-statement', 'transfer',
  'distance-table', 'demand-statement', 'negotiation-proposal',
  'give', 'take', 'negotiation-report',
  'bid', 'bid-accepted', 'bid-rejected',
  ...CENTRAL_V3_TYPES, ...MARKET_TYPES,
]);
const CYCLE_TYPES = new Set([
  'status-statement', 'transfer', 'demand-statement', 'negotiation-proposal',
  'give', 'take', 'negotiation-report', 'error',
  'bid', 'bid-accepted', 'bid-rejected', 'trade-recorded', 'imbalance-settlement',
  'offer', 'offer-updated', 'offer-withdrawn', 'market-closed',
]);
const BID_REJECTED_CODES = { QUANTITY_UNAVAILABLE: 409, OFFER_WITHDRAWN: 410, BID_TOO_SMALL: 422, MARKET_CLOSED: 410, SELF_TRADE: 422 };
const CITY_CODE_PATTERN = /^[A-Z]{3}$/;
const NACK_CODES = { MALFORMED_MESSAGE: 422, UNKNOWN_TYPE: 400, IDPK_EQUALS_MSGID: 422, IDENTITY_MISMATCH: 403 };
const ERROR_CODES = { CYCLE_UNKNOWN: [404], CYCLE_EXPIRED: [410], PRICE_ABOVE_CAP: [422], OVER_CAPACITY: [409], REPORT_TOO_EARLY: [422, 425], TYPE_RETIRED: [410] };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && Boolean(value.trim());
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isNonnegative = (value) => isNumber(value) && value >= 0;
const isPositive = (value) => isNumber(value) && value > 0;
const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);
const isKnownType = (type) => MESSAGE_TYPES.has(type);
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isCityCode = (value) => typeof value === 'string' && CITY_CODE_PATTERN.test(value);

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

    case 'bid':
      if (!isText(data.offerId)) return invalid('bid requiere data.offerId.');
      if (!isPositiveInteger(data.quantity)) return invalid('bid requiere data.quantity entero positivo.');
      break;
    case 'bid-accepted':
      if (!isUuid(data.target)) return invalid('bid-accepted requiere data.target, el msgId del bid.');
      if (!isText(data.offerId) || !isText(data.swapId) || !isText(data.swapToken)) return invalid('bid-accepted requiere offerId, swapId y swapToken.');
      if (!isPositiveInteger(data.quantity) || !isNonnegative(data.pricePerEnergy) || !isNonnegative(data.amount)) return invalid('bid-accepted requiere quantity, pricePerEnergy y amount validos.');
      if (!isTimestamp(data.expiresAt)) return invalid('bid-accepted requiere expiresAt ISO 8601.');
      break;
    case 'bid-rejected':
      if (typeof event.reason !== 'string' || !Object.hasOwn(BID_REJECTED_CODES, event.reason) || event.code !== BID_REJECTED_CODES[event.reason]) {
        return invalid('bid-rejected requiere una combinacion valida de reason y code.');
      }
      if (!isUuid(data.target)) return invalid('bid-rejected requiere data.target, el msgId del bid.');
      if (event.reason === 'QUANTITY_UNAVAILABLE' && !isNonnegative(data.available)) return invalid('QUANTITY_UNAVAILABLE requiere data.available.');
      break;
    case 'trade-recorded':
      if (!isText(data.swapId) || !isCityCode(data.buyer) || !isCityCode(data.seller)) return invalid('trade-recorded requiere swapId, buyer y seller.');
      if (!isNonnegative(data.transportTotal)) return invalid('trade-recorded requiere transportTotal no negativo.');
      break;
    case 'imbalance-settlement':
      if (!isNumber(data.total) || !isNumber(data.coverage)) return invalid('imbalance-settlement requiere total y coverage numericos.');
      break;
    case 'swap-proposed':
    case 'swap-settled':
    case 'swap-cancelled':
    case 'swap-expired':
      if (!isText(data.swapId)) return invalid(`${type} requiere data.swapId.`);
      break;
    case 'swap-rejected':
      if (!isText(event.reason) || !isNumber(event.code)) return invalid('swap-rejected requiere reason y code.');
      if (!['propose', 'accept', 'cancel'].includes(data.operation)) return invalid('swap-rejected requiere data.operation.');
      break;
    case 'offer':
      if (!isText(data.offerId) || !isPositiveInteger(data.quantity) || !isNonnegative(data.pricePerEnergy)) return invalid('offer requiere offerId, quantity entero positivo y pricePerEnergy.');
      break;
    case 'offer-updated':
      if (!isText(data.offerId) || !Number.isInteger(data.remaining) || data.remaining < 0 || !isNonnegative(data.pricePerEnergy)) return invalid('offer-updated requiere offerId, remaining y pricePerEnergy.');
      break;
    case 'offer-withdrawn':
      if (!isText(data.offerId)) return invalid('offer-withdrawn requiere offerId.');
      break;
    case 'market-closed':
      break;
  }
  return null;
}

module.exports = {
  isUuid, isTimestamp, isObject, isKnownType, isCityCode, validateContent,
  CENTRAL_V3_TYPES, PEER_TYPES, MARKET_TYPES, WALLET_EVENT_TYPES,
};
