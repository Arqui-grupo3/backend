// /buyer/config es un alias de /config (ADR 0006: una sola configuración versionada).
// spanSeconds es el span de compra y enabled es el interruptor del mercado (marketEnabled):
// apagarlo detiene al comprador y al vendedor a la vez.
const strategy = require('../config');

function view(c) {
  return { version: c.version, spanSeconds: c.spanSeconds, enabled: c.marketEnabled };
}

async function getConfig(db) {
  return view(await strategy.getCurrent(db));
}

async function setConfig(pool, { spanSeconds, enabled } = {}) {
  if ((spanSeconds === undefined && enabled === undefined) ||
      (spanSeconds !== undefined && (!Number.isSafeInteger(spanSeconds) || spanSeconds < 0 || spanSeconds >= 540)) ||
      (enabled !== undefined && typeof enabled !== 'boolean')) {
    const error = new Error('spanSeconds debe ser un entero entre 0 y 539; enabled debe ser booleano');
    error.statusCode = 422;
    throw error;
  }
  const body = { note: 'vía /buyer/config' };
  if (spanSeconds !== undefined) body.spanSeconds = spanSeconds;
  if (enabled !== undefined) body.marketEnabled = enabled;
  const { previous, current } = await strategy.updateConfig(pool, body);
  return { ...view(current), previous: view(previous) };
}

module.exports = { getConfig, setConfig };
