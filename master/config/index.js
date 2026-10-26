// Configuración en caliente de la estrategia (ADR 0006).
// - Cada cambio crea una versión nueva en strategy_config.
// - Precio, cantidad, span y bajada de precio se congelan por ciclo al llegar el status-statement:
//   un cambio a mitad de ciclo rige desde el ciclo siguiente.
// - marketEnabled es el interruptor de emergencia: se lee en vivo y rige altiro.

const FIELDS = {
  marketEnabled: 'market_enabled',
  priceFactor: 'price_factor',
  maxQuantity: 'max_quantity',
  spanSeconds: 'span_seconds',
  priceDecayMinutes: 'price_decay_minutes'
};

function columns(t = '') {
  const p = t ? `${t}.` : '';
  return `${p}version, ${p}market_enabled AS "marketEnabled", ${p}price_factor::float8 AS "priceFactor",
  ${p}max_quantity AS "maxQuantity", ${p}span_seconds AS "spanSeconds",
  ${p}price_decay_minutes AS "priceDecayMinutes", ${p}updated_by AS "updatedBy",
  ${p}note, ${p}created_at AS "createdAt"`;
}
const SELECT = columns();

function fail(message) {
  const err = new Error(message);
  err.statusCode = 422;
  throw err;
}

function validatePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Se esperaba un objeto JSON');
  const unknown = Object.keys(body).filter((k) => !(k in FIELDS) && k !== 'note');
  if (unknown.length) fail(`Campos no permitidos: ${unknown.join(', ')}`);

  const patch = {};
  if ('marketEnabled' in body) {
    if (typeof body.marketEnabled !== 'boolean') fail('marketEnabled debe ser true o false');
    patch.marketEnabled = body.marketEnabled;
  }
  if ('priceFactor' in body) {
    const v = body.priceFactor;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1) fail('priceFactor debe ser un número mayor que 0 y hasta 1');
    patch.priceFactor = v;
  }
  if ('maxQuantity' in body) {
    const v = body.maxQuantity;
    if (v !== null && (!Number.isInteger(v) || v < 0)) fail('maxQuantity debe ser un entero mayor o igual a 0, o null para ofrecer todo');
    patch.maxQuantity = v;
  }
  if ('spanSeconds' in body) {
    const v = body.spanSeconds;
    if (!Number.isInteger(v) || v < 0 || v > 540) fail('spanSeconds debe ser un entero entre 0 y 540 (antes de lastBidAt)');
    patch.spanSeconds = v;
  }
  if ('priceDecayMinutes' in body) {
    const v = body.priceDecayMinutes;
    if (!Number.isInteger(v) || v < 0 || v > 8) fail('priceDecayMinutes debe ser un entero entre 0 (precio fijo) y 8');
    patch.priceDecayMinutes = v;
  }
  if ('note' in body && body.note !== null && typeof body.note !== 'string') fail('note debe ser texto');
  if (!Object.keys(patch).length) fail('No hay cambios: envía al menos uno de marketEnabled, priceFactor, maxQuantity, spanSeconds o priceDecayMinutes');
  return { patch, note: typeof body.note === 'string' ? body.note.slice(0, 500) : null };
}

async function getCurrent(pool) {
  const res = await pool.query(`SELECT ${SELECT} FROM strategy_config ORDER BY version DESC LIMIT 1`);
  return res.rows[0] || null;
}

async function getHistory(pool, limit = 20) {
  const res = await pool.query(`SELECT ${SELECT} FROM strategy_config ORDER BY version DESC LIMIT $1`, [limit]);
  return res.rows;
}

// Crea una versión nueva = versión actual + cambios. El lock evita que dos PUT
// simultáneos partan de la misma versión y uno pise al otro.
async function updateConfig(pool, body, { updatedBy = null } = {}) {
  const { patch, note } = validatePatch(body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(2173, 6)');
    const current = (await client.query(`SELECT ${SELECT} FROM strategy_config ORDER BY version DESC LIMIT 1`)).rows[0];
    const next = { ...current, ...patch };
    const res = await client.query(
      `INSERT INTO strategy_config (market_enabled, price_factor, max_quantity, span_seconds, price_decay_minutes, updated_by, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${SELECT}`,
      [next.marketEnabled, next.priceFactor, next.maxQuantity, next.spanSeconds, next.priceDecayMinutes, updatedBy, note]
    );
    await client.query('COMMIT');
    return { previous: current, current: res.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Congela la versión vigente para el ciclo (solo la primera vez) y devuelve
// esa versión con marketEnabled leído en vivo.
async function freezeForCycle(pool, cycleId) {
  await pool.query(
    `INSERT INTO cycle_config (cycle_id, config_version)
     SELECT $1, MAX(version) FROM strategy_config
     ON CONFLICT (cycle_id) DO NOTHING`,
    [cycleId]
  );
  return getForCycle(pool, cycleId);
}

async function getForCycle(pool, cycleId) {
  const res = await pool.query(
    `SELECT ${columns('s')}
     FROM cycle_config c JOIN strategy_config s ON s.version = c.config_version
     WHERE c.cycle_id = $1`,
    [cycleId]
  );
  const frozen = res.rows[0];
  if (!frozen) return null;
  const live = await getCurrent(pool);
  return { ...frozen, marketEnabled: live.marketEnabled };
}

async function isMarketEnabled(pool) {
  const current = await getCurrent(pool);
  return current ? current.marketEnabled : false;
}

module.exports = { validatePatch, getCurrent, getHistory, updateConfig, freezeForCycle, getForCycle, isMarketEnabled };
