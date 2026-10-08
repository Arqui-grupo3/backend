const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { migrate, recordEvent, getCycleState } = require('../ledger');
const { createProposal, getNegotiations, runOnce, startWorker } = require('../negotiations');
const reports = require('../reports');

if (!process.env.TEST_DATABASE_URL) throw Error('Define TEST_DATABASE_URL de pruebas');

const start = new Date('2030-01-01T12:00:00Z');
const at = ms => new Date(+start + ms);
const closes = at(20 * 60000);

const message = (type, data, extra = {}) => ({
  idpk: randomUUID(),
  msgId: randomUUID(),
  type,
  sender: 'central',
  cycleId: 'cycle-neg',
  timestamp: start.toISOString(),
  data,
  ...extra,
});

const status = () =>
  message('status-statement', {
    energy: { generationCapacity: 1000, consumption: 800, generationCost: 200 },
    validUntil: closes.toISOString(),
  });

async function fixture(t) {
  const schema = 'neg_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` };
  const pool = new Pool(options);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await pool.query(`
    CREATE TABLE events(id UUID PRIMARY KEY, idpk TEXT UNIQUE NOT NULL, msg_id UUID, type TEXT NOT NULL, cycle_id TEXT, package_body JSONB, received_at TIMESTAMPTZ NOT NULL, seq BIGSERIAL);
    CREATE TABLE api_audit(id UUID PRIMARY KEY, idpk TEXT, msg_id UUID, type TEXT, cycle_id TEXT, reason TEXT, details JSONB, received_at TIMESTAMPTZ, seq BIGSERIAL);
  `);
  await migrate(pool);
  await recordEvent(pool, status());
  await recordEvent(pool, message('transfer', { quantity: 100000 }));
  return { pool, options };
}

test('flujo completo take: propuesta -> confirmacion take -> emite transfer saliente -> ledger actualizado', async (t) => {
  const { pool } = await fixture(t);
  const outgoing = [];
  const publish = async (env) => { outgoing.push(env); };

  // 1. Crear propuesta take (comprar 100 kWh a max 200)
  const created = await createProposal(pool, { cycleId: 'cycle-neg', direction: 'take', quantity: 100, pricePerEnergy: 200 });
  assert.equal(created.status, 'pending');

  // 2. Worker ejecuta y publica propuesta
  const ran1 = await runOnce(pool, publish, start);
  assert.equal(ran1, true);
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].type, 'negotiation-proposal');
  assert.equal(outgoing[0].idpk, created.idpk);
  assert.equal(outgoing[0].data.direction, 'take');
  assert.equal(outgoing[0].data.quantity, 100);

  const proposalMsgId = outgoing[0].msgId;

  // 3. Central confirma con 'take'
  const takeEvent = message('take', { target: proposalMsgId, energy: 100, pricePerEnergy: 200 });
  await recordEvent(pool, takeEvent);

  const jobsAfterConfirm = await getNegotiations(pool, { cycleId: 'cycle-neg' });
  assert.equal(jobsAfterConfirm[0].status, 'confirmed');
  assert.equal(jobsAfterConfirm[0].phase, 'payment_send');
  assert.equal(Number(jobsAfterConfirm[0].paymentAmount), 20000);

  // 4. Worker procesa pago saliente (take)
  const ran2 = await runOnce(pool, publish, at(500));
  assert.equal(ran2, true);
  assert.equal(outgoing.length, 2);
  assert.equal(outgoing[1].type, 'transfer');
  assert.equal(outgoing[1].cityId, 'REE');
  assert.equal(outgoing[1].data.becauseOf, takeEvent.msgId);
  assert.equal(outgoing[1].data.quantity, 20000);

  // 5. Verificar estado contable en cycle_state
  const state = await getCycleState(pool, 'cycle-neg');
  // Initial energy = 1000 - 800 = 200. Take adds 100 -> 300
  assert.equal(state.energyBalance, '300');
  // Initial budget = 100000. Outgoing transfer discounts 20000 -> 80000
  assert.equal(state.budgetBalance, '80000');

  const finalJobs = await getNegotiations(pool, { cycleId: 'cycle-neg' });
  assert.equal(finalJobs[0].status, 'paid');
  assert.equal(finalJobs[0].phase, 'completed');
});

test('flujo completo give: propuesta -> confirmacion give -> central transfiere fondos -> ledger actualizado', async (t) => {
  const { pool } = await fixture(t);
  const outgoing = [];
  const publish = async (env) => { outgoing.push(env); };

  // 1. Crear propuesta give (vender 50 kWh a 210)
  const created = await createProposal(pool, { cycleId: 'cycle-neg', direction: 'give', quantity: 50, pricePerEnergy: 210 });

  // 2. Worker publica propuesta
  await runOnce(pool, publish, start);
  assert.equal(outgoing.length, 1);
  const proposalMsgId = outgoing[0].msgId;

  // 3. Central confirma give
  const giveEvent = message('give', { target: proposalMsgId, energy: 50, pricePerEnergy: 210 });
  await recordEvent(pool, giveEvent);

  const jobsAfterConfirm = await getNegotiations(pool, { cycleId: 'cycle-neg' });
  assert.equal(jobsAfterConfirm[0].status, 'confirmed');
  assert.equal(jobsAfterConfirm[0].phase, 'payment_wait');

  // Antes del pago, el ledger no cambia
  const stateBeforePayment = await getCycleState(pool, 'cycle-neg');
  assert.equal(stateBeforePayment.energyBalance, '200');
  assert.equal(stateBeforePayment.budgetBalance, '100000');

  // 4. Central transfiere fondos (50 * 210 = 10500)
  const transferFromCentral = message('transfer', { becauseOf: giveEvent.msgId, quantity: 10500 });
  await recordEvent(pool, transferFromCentral);

  // 5. Verificar ledger actualizado
  const stateAfterPayment = await getCycleState(pool, 'cycle-neg');
  // Energy: 200 - 50 = 150
  assert.equal(stateAfterPayment.energyBalance, '150');
  // Budget: 100000 + 10500 = 110500
  assert.equal(stateAfterPayment.budgetBalance, '110500');

  const finalJobs = await getNegotiations(pool, { cycleId: 'cycle-neg' });
  assert.equal(finalJobs[0].status, 'paid');
  assert.equal(finalJobs[0].phase, 'completed');
});

test('timeout de 30s sin confirmacion: reintenta con el MISMO idpk y nuevo msgId', async (t) => {
  const { pool } = await fixture(t);
  const outgoing = [];
  const publish = async (env) => { outgoing.push(env); };

  const created = await createProposal(pool, { cycleId: 'cycle-neg', direction: 'take', quantity: 10, pricePerEnergy: 200 });

  // Intento 1 en t = 0
  await runOnce(pool, publish, start);
  assert.equal(outgoing.length, 1);
  const first = outgoing[0];

  // A los 29 segundos: aún no vence el timeout de 30s
  const ranBeforeTimeout = await runOnce(pool, publish, at(29000));
  assert.equal(ranBeforeTimeout, false);
  assert.equal(outgoing.length, 1);

  // A los 30 segundos exactos: vence timeout de 30s y se dispara reintento
  const ranAtTimeout = await runOnce(pool, publish, at(30000));
  assert.equal(ranAtTimeout, true);
  assert.equal(outgoing.length, 2);
  const second = outgoing[1];

  // Regla AD3 fundamental: MISMO idpk, NUEVO msgId
  assert.equal(second.idpk, first.idpk);
  assert.notEqual(second.msgId, first.msgId);
  assert.equal(second.type, 'negotiation-proposal');

  const jobs = await getNegotiations(pool, { cycleId: 'cycle-neg' });
  assert.equal(jobs[0].attempts, 2);
});

test('timeout de 30s esperando pago de la central en give: reintenta propuesta con mismo idpk', async (t) => {
  const { pool } = await fixture(t);
  const outgoing = [];
  const publish = async (env) => { outgoing.push(env); };

  await createProposal(pool, { cycleId: 'cycle-neg', direction: 'give', quantity: 20, pricePerEnergy: 210 });
  await runOnce(pool, publish, start);
  assert.equal(outgoing.length, 1);
  const firstMsgId = outgoing[0].msgId;

  // Central confirma give a los 5 segundos
  const giveEvent = message('give', { target: firstMsgId, energy: 20, pricePerEnergy: 210 }, { timestamp: at(5000).toISOString() });
  await recordEvent(pool, giveEvent);

  // Pasan 30 segundos sin que la central envíe transfer (t = 35001ms)
  // Enunciado: "Si no llega, asuman que no hubo operacion real y reintenten la operacion con el mismo idpk."
  const ranRetry = await runOnce(pool, publish, at(36000));
  assert.equal(ranRetry, true);
  assert.equal(outgoing.length, 2);

  const retry = outgoing[1];
  assert.equal(retry.idpk, outgoing[0].idpk);
  assert.notEqual(retry.msgId, outgoing[0].msgId);
  assert.equal(retry.type, 'negotiation-proposal');

  // El ledger se mantuvo intacto sin cambios
  const state = await getCycleState(pool, 'cycle-neg');
  assert.equal(state.energyBalance, '200');
  assert.equal(state.budgetBalance, '100000');
});

test('limite de reintentos: tras 4 intentos vencidos transiciona a expired', async (t) => {
  const { pool } = await fixture(t);
  const outgoing = [];
  const publish = async (env) => { outgoing.push(env); };

  await createProposal(pool, { cycleId: 'cycle-neg', direction: 'take', quantity: 15, pricePerEnergy: 200 });

  // 4 intentos sucesivos separados por 30s
  for (let i = 0; i < 4; i++) {
    const ran = await runOnce(pool, publish, at(i * 30000));
    assert.equal(ran, true);
  }
  assert.equal(outgoing.length, 4);
  assert.equal(new Set(outgoing.map(o => o.msgId)).size, 4);
  assert.equal(new Set(outgoing.map(o => o.idpk)).size, 1);

  // Quinto intento tras vencer el cuarto
  const ran5 = await runOnce(pool, publish, at(4 * 30000));
  assert.equal(ran5, false);

  const jobs = await getNegotiations(pool, { cycleId: 'cycle-neg' });
  assert.equal(jobs[0].status, 'expired');
});

test('manejo de errores de central: PRICE_ABOVE_CAP y OVER_CAPACITY marcan failed y guardan cap/spare', async (t) => {
  const { pool } = await fixture(t);
  const outgoing = [];
  const publish = async (env) => { outgoing.push(env); };

  // 1. PRICE_ABOVE_CAP
  const jobCap = await createProposal(pool, { cycleId: 'cycle-neg', direction: 'take', quantity: 10, pricePerEnergy: 250 });
  await runOnce(pool, publish, start);
  const msgCap = outgoing[0].msgId;

  await recordEvent(pool, message('error', { target: msgCap, message: 'bid exceeds cap', cap: 220.5 }, { reason: 'PRICE_ABOVE_CAP', code: 422 }));

  const jobs1 = await getNegotiations(pool, { cycleId: 'cycle-neg' });
  const foundCap = jobs1.find(j => j.idpk === jobCap.idpk);
  assert.equal(foundCap.status, 'failed');
  assert.equal(foundCap.lastError, 'PRICE_ABOVE_CAP');
  assert.equal(Number(foundCap.cap), 220.5);

  // 2. OVER_CAPACITY
  const jobSpare = await createProposal(pool, { cycleId: 'cycle-neg', direction: 'give', quantity: 500, pricePerEnergy: 210 });
  await runOnce(pool, publish, at(100));
  const msgSpare = outgoing[1].msgId;

  await recordEvent(pool, message('error', { target: msgSpare, message: 'exceeds vendible energy', spare: 200 }, { reason: 'OVER_CAPACITY', code: 409 }));

  const jobs2 = await getNegotiations(pool, { cycleId: 'cycle-neg' });
  const foundSpare = jobs2.find(j => j.idpk === jobSpare.idpk);
  assert.equal(foundSpare.status, 'failed');
  assert.equal(foundSpare.lastError, 'OVER_CAPACITY');
  assert.equal(Number(foundSpare.spare), 200);
});

test('desbloqueo de negotiation-report cuando las negociaciones estan liquidadas', async (t) => {
  const { pool } = await fixture(t);
  const outgoing = [];
  const publish = async (env) => { outgoing.push(env); };

  // Realizar una negociacion take completa
  await createProposal(pool, { cycleId: 'cycle-neg', direction: 'take', quantity: 50, pricePerEnergy: 200 });
  await runOnce(pool, publish, start);
  const propMsg = outgoing[0].msgId;
  await recordEvent(pool, message('take', { target: propMsg, energy: 50, pricePerEnergy: 200 }));
  await runOnce(pool, publish, at(500)); // emite transfer

  // Ahora la negociacion esta 'paid'. El negotiation-report del ciclo NO debe quedar bloqueado
  const publishedReports = [];
  const reportOpens = at(15 * 60000);
  const ranReport = await reports.runOnce(pool, async (e) => { publishedReports.push(e); }, reportOpens);
  assert.equal(ranReport, true);
  assert.equal(publishedReports.length, 1);
  // Initial energy (200) + take (50) = 250
  assert.equal(publishedReports[0].data.energyBalance, 250);
  // Initial budget (100000) - take payment (10000) = 90000
  assert.equal(publishedReports[0].data.budgetBalance, 90000);
});
