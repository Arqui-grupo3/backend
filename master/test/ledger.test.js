const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const { Pool } = require('pg');
const { migrate, getCycleState } = require('../ledger');

// Explicit test URL mandatory: never fall back to the application's database.
if (!process.env.TEST_DATABASE_URL) throw Error('Define TEST_DATABASE_URL para una base Postgres de pruebas.');
const schema = 'ledger_test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
let server, base, logs = '';
const message = (type, cycleId, data, extra = {}) => ({
  idpk: randomUUID(), msgId: randomUUID(), type, cycleId, sender: 'central',
  timestamp: '2026-10-07T12:00:00Z', data, ...extra,
});
const status = (cycle, extra = {}) => message('status-statement', cycle, {
  energy: { generationCapacity: 100, consumption: 120, generationCost: 2.5 },
  validUntil: '2026-10-07T12:20:00Z',
}, extra);
async function post(event) {
  const r = await fetch(base + '/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
  return { status: r.status, body: await r.json() };
}
async function startServer() {
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = new URL(process.env.TEST_DATABASE_URL);
  server = spawn(process.execPath, ['index.js'], { cwd: require('node:path').join(__dirname, '..'), env: {
    ...process.env, NEW_RELIC_ENABLED: 'false', AUTH_REQUIRED: 'false', PORT: String(port),
    PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1), PGOPTIONS: `-c search_path=${schema}`,
  }, stdio: ['ignore','pipe','pipe'] });
  server.stdout.on('data', d => logs += d); server.stderr.on('data', d => logs += d);
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch {}
    if (server.exitCode !== null) throw Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('El servidor no inicio: ' + logs);
}
async function stopServer() {
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  // Simulate the existing E0 table and a historical record before migration.
  await pool.query(`CREATE TABLE events (id UUID PRIMARY KEY,idpk TEXT UNIQUE NOT NULL,type TEXT NOT NULL,
    package_body JSONB,received_at TIMESTAMPTZ NOT NULL,seq BIGSERIAL)`);
  await pool.query(`INSERT INTO events VALUES ($1,'legacy','legacy',$2,now(),DEFAULT)`, [randomUUID(), { preserved: true }]);
  await startServer();
});
after(async () => { await stopServer(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('migracion aditiva e idempotente conserva E0', async () => {
  await migrate(pool);
  assert.deepEqual((await pool.query("SELECT package_body FROM events WHERE idpk='legacy'")).rows[0].package_body, { preserved: true });
});
test('HTTP aplica estado y fondos; usa numeric exacto y expone proyeccion', async () => {
  assert.equal((await post(status('alpha'))).status, 201);
  for (const quantity of [0.1, 0.2]) assert.equal((await post(message('transfer','alpha',{quantity}))).status,201);
  const r = await fetch(base + '/cycles/alpha/ledger'); assert.equal(r.status,200);
  const state = await r.json(); assert.equal(state.energyBalance,'-20'); assert.equal(state.budgetBalance,'0.3');
  assert.equal(state.initialized,true); assert.equal(state.lastOperationType,'transfer');
  assert.equal(state.scope,'phase1-status-and-incoming-transfers');
});
test('duplicados concurrentes e idpk en mayusculas no vuelven a abonar', async () => {
  const e = message('transfer','alpha',{quantity:10});
  const results = await Promise.all(Array.from({length:8},(_,i) => post({...e,idpk:i%2 ? e.idpk.toUpperCase():e.idpk,msgId:randomUUID()})));
  assert.equal(results.filter(r=>r.status===201).length,1);
  assert.equal(results.filter(r=>r.status===200 && r.body.duplicate).length,7);
  assert.equal((await getCycleState(pool,'alpha')).budgetBalance,'10.3');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM api_audit WHERE idpk=$1',[e.idpk])).rows[0].n,7);
});
test('transfer antes del estado, carry-over y ciclos solapados con IDs opacos', async () => {
  await post(message('transfer','z-next',{quantity:5}));
  let state = await getCycleState(pool,'z-next'); assert.equal(state.initialized,false); assert.equal(state.energyBalance,null);
  assert.equal(state.budgetBalance,'15.3');
  await post(status('z-next'));
  await post(message('transfer','alpha',{quantity:-2}));
  assert.equal((await getCycleState(pool,'alpha')).budgetBalance,'13.3');
  // Historical observation is stable when a different cycle gets an event.
  assert.equal((await getCycleState(pool,'z-next')).budgetBalance,'15.3');
  await post(status('z-next'));
  state = await getCycleState(pool,'z-next'); assert.equal(state.budgetBalance,'13.3'); assert.equal(state.energyBalance,'-20');
});
test('estado anterior recibido tarde no reemplaza al mas reciente ni suma energia dos veces', async () => {
  const older = status('z-next',{timestamp:'2026-10-07T11:00:00Z'}); older.data.energy.generationCapacity=999;
  await post(older); assert.equal((await getCycleState(pool,'z-next')).energyBalance,'-20');
});
test('fallo entre historial y ledger revierte ambas escrituras; reintento funciona', async () => {
  const e = message('transfer','rollback',{quantity:7});
  await pool.query(`CREATE FUNCTION reject_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.cycle_id='rollback' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER probe BEFORE INSERT ON ledger_events FOR EACH ROW EXECUTE FUNCTION reject_probe()`);
  try {
    assert.equal((await post(e)).status,500);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM events WHERE idpk=$1',[e.idpk])).rows[0].n,0);
  } finally { await pool.query('DROP TRIGGER probe ON ledger_events; DROP FUNCTION reject_probe()'); }
  assert.equal((await post(e)).status,201);
});
test('payload invalido no altera tablas; otros tipos se preservan sin efecto contable', async () => {
  const e = status('invalid'); e.data.energy.consumption=-1;
  assert.equal((await post(e)).status,422); assert.equal(await getCycleState(pool,'invalid'),null);
  const other = message('demand-statement','phase2',{balance:{quantity:10,valuePerKwh:3}});
  const r = await post(other); assert.equal(r.status,201); assert.equal(r.body.ledgerApplied,false);
  assert.equal(await getCycleState(pool,'phase2'),null);
  assert.equal((await fetch(base + '/cycles/phase2/ledger')).status,404);
});
test('event log impide update/delete/truncate y reinicio reconstruye el mismo estado', async () => {
  for (const query of ["UPDATE ledger_events SET type=type", 'DELETE FROM ledger_events', 'TRUNCATE ledger_events']) {
    await assert.rejects(pool.query(query), /append-only/);
  }
  const before = await getCycleState(pool,'alpha');
  await stopServer(); await startServer();
  assert.deepEqual(await getCycleState(pool,'alpha'),before);
  const newPool = new Pool({ connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}` });
  try { assert.deepEqual(await getCycleState(newPool,'alpha'),before); } finally { await newPool.end(); }
});
