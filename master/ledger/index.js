const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ledgerTypes = new Set(['status-statement', 'transfer']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const timestamp = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(`${x.slice(0, 19)}Z`).toISOString().slice(0, 19) === x.slice(0, 19);

function validate(event) {
  const fail = message => { const error = new Error(message); error.statusCode = 422; throw error; };
  if (!object(event) || typeof event.idpk !== 'string' || !event.idpk.trim() || typeof event.type !== 'string' || !event.type.trim()) {
    fail('Se requieren idpk y type.');
  }
  if (event.receivedAt !== undefined && !timestamp(event.receivedAt)) fail('receivedAt invalido.');
  if (!ledgerTypes.has(event.type)) return;
  if (!uuid.test(event.idpk) || !uuid.test(event.msgId || '') || event.idpk.toLowerCase() === event.msgId.toLowerCase()) fail('idpk y msgId deben ser UUID distintos.');
  if (!timestamp(event.timestamp) || typeof event.cycleId !== 'string' || !event.cycleId.trim()) fail('timestamp y cycleId requeridos.');
  if (event.sender !== 'central' || !object(event.data)) fail('Se requiere sender central y data.');
  if (event.type === 'transfer') {
    if (!Number.isFinite(event.data.quantity)) fail('quantity debe ser un numero finito.');
    if ('becauseOf' in event.data && !uuid.test(event.data.becauseOf)) fail('becauseOf debe ser UUID.');
  } else {
    const energy = event.data.energy;
    if (!object(energy) || ['generationCapacity', 'consumption', 'generationCost'].some(k => !Number.isFinite(energy[k]) || energy[k] < 0)) fail('Estado energetico invalido.');
    if (!timestamp(event.data.validUntil)) fail('validUntil invalido.');
  }
}

async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(2173, 1)');
    await client.query(readFileSync(join(__dirname, '../migrations/001-ledger.sql'), 'utf8'));
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

async function recordEvent(pool, event) {
  validate(event);
  const client = await pool.connect();
  const idpk = uuid.test(event.idpk) ? event.idpk.toLowerCase() : event.idpk;
  const receivedAt = event.receivedAt || new Date().toISOString();
  try {
    await client.query('BEGIN');
    // Serialize application order, not just allocation of sequence numbers.
    // Also makes concurrent redelivery and legacy uppercase UUIDs safe.
    await client.query('SELECT pg_advisory_xact_lock(2173, 1)');
    const existing = await client.query('SELECT id FROM events WHERE lower(idpk) = lower($1) LIMIT 1', [idpk]);
    if (existing.rowCount) {
      await client.query(`INSERT INTO api_audit (id,idpk,msg_id,type,cycle_id,reason,details,received_at)
        VALUES ($1,$2,$3,$4,$5,'DUPLICATE_IDPK',$6,$7)`,
      [randomUUID(), idpk, uuid.test(event.msgId || '') ? event.msgId : null, event.type, event.cycleId ?? null,
        { message: 'Operacion ya recibida; no se aplica nuevamente.', originalEventId: existing.rows[0].id }, receivedAt]);
      await client.query('COMMIT');
      return { inserted: false, id: existing.rows[0].id, receivedAt };
    }
    const id = randomUUID();
    await client.query(`INSERT INTO events (id,idpk,msg_id,type,cycle_id,package_body,received_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, idpk, event.msgId ?? null, event.type, event.cycleId ?? null, event.data ?? event.packageBody ?? {}, receivedAt]);
    if (ledgerTypes.has(event.type)) {
      await client.query(`INSERT INTO ledger_events (id,idpk,msg_id,cycle_id,type,payload,envelope,occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id,idpk,event.msgId,event.cycleId,event.type,event.data,event,event.timestamp]);
    }
    await client.query('COMMIT');
    return { inserted: true, id, receivedAt, ledgerApplied: ledgerTypes.has(event.type) };
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

// PostgreSQL numeric is deliberately returned as decimal strings, avoiding
// binary floating point rounding for credits and energy.
async function getCycleState(pool, cycleId) {
  const result = await pool.query(`SELECT cycle_id AS "cycleId", budget_balance AS "budgetBalance",
    energy_balance AS "energyBalance", generation_capacity AS "generationCapacity",
    consumption, generation_cost AS "generationCost", valid_until AS "validUntil", initialized,
    last_operation_seq AS "asOfSequence", last_operation_id AS "lastOperationId",
    last_operation_type AS "lastOperationType", last_operation_at AS "lastOperationAt"
    FROM cycle_state WHERE cycle_id = $1`, [cycleId]);
  return result.rows[0] || null;
}

module.exports = { migrate, recordEvent, getCycleState };
