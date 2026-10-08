const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {Pool} = require('pg');
const {migrate,recordEvent} = require('../ledger');
const {runOnce,startWorker,getReport} = require('../reports');
const {createPublisher} = require('../../connector/publisher');
if(!process.env.TEST_DATABASE_URL)throw Error('Define TEST_DATABASE_URL de pruebas');
const start=new Date('2030-01-01T12:00:00Z');
const at=ms=>new Date(+start+ms);
const opens=at(15*60000), closes=at(20*60000);
const message=(type,data,extra={})=>({idpk:randomUUID(),msgId:randomUUID(),type,sender:'central',cycleId:'cycle-A',timestamp:start.toISOString(),data,...extra});
const status=()=>message('status-statement',{energy:{generationCapacity:100,consumption:120,generationCost:2},validUntil:closes.toISOString()});
async function fixture(t){
 const schema='report_test_'+randomUUID().replaceAll('-','');
 const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const options={connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`};
 const pool=new Pool(options);
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 await pool.query(`CREATE TABLE events(id UUID PRIMARY KEY,idpk TEXT UNIQUE NOT NULL,msg_id UUID,type TEXT NOT NULL,cycle_id TEXT,package_body JSONB,received_at TIMESTAMPTZ NOT NULL,seq BIGSERIAL);
 CREATE TABLE api_audit(id UUID PRIMARY KEY,idpk TEXT,msg_id UUID,type TEXT,cycle_id TEXT,reason TEXT,details JSONB,received_at TIMESTAMPTZ,seq BIGSERIAL);`);
 await migrate(pool);await recordEvent(pool,status());
 await recordEvent(pool,message('transfer',{quantity:500}));
 return {pool,options};
}

test('espera apertura y publica snapshot real con demandas; workers concurrentes envian una vez',async t=>{
 const {pool}=await fixture(t);const published=[];
 await recordEvent(pool,message('demand-statement',{balance:{quantity:30,valuePerKwh:2}}));
 assert.equal(await runOnce(pool,async e=>published.push(e),at(15*60000-1)),false);
 await Promise.all([runOnce(pool,async e=>published.push(e),opens),runOnce(pool,async e=>published.push(e),opens)]);
 assert.equal(published.length,1);assert.deepEqual(published[0].data,{budgetBalance:440,energyBalance:10});
 const job=await getReport(pool,'cycle-A');assert.equal(job.status,'sent');assert.equal(job.attemptCount,1);
 assert.equal(job.attempts[0].msg_id,published[0].msgId);assert.notEqual(published[0].idpk,published[0].msgId);
});
test('ACK inmediato seguido de TOO_EARLY gana sobre respuesta HTTP; reintenta exactamente opensAt y mismo idpk',async t=>{
 const {pool}=await fixture(t);let first;
 const corrected=at(16*60000+137);
 await runOnce(pool,async e=>{
  first=e;
  await recordEvent(pool,message('ack',{target:e.msgId}));
  assert.equal((await getReport(pool,'cycle-A')).status,'acknowledged');
  await recordEvent(pool,message('error',{target:e.msgId,message:'early',opensAt:corrected.toISOString()},{reason:'REPORT_TOO_EARLY',code:422}));
 },opens);
 let job=await getReport(pool,'cycle-A');assert.equal(job.status,'pending');assert.equal(+job.due_at,+corrected);
 const outgoing=[];
 assert.equal(await runOnce(pool,async e=>outgoing.push(e),new Date(+corrected-1)),false);
 await recordEvent(pool,message('demand-statement',{balance:{quantity:-5,valuePerKwh:3}}));
 assert.equal(await runOnce(pool,async e=>outgoing.push(e),corrected),true);
 assert.equal(outgoing.length,1);assert.equal(outgoing[0].idpk,first.idpk);assert.notEqual(outgoing[0].msgId,first.msgId);
 assert.deepEqual(outgoing[0].data,{budgetBalance:515,energyBalance:-25});
 await recordEvent(pool,message('error',{target:first.msgId,message:'old',opensAt:at(18*60000).toISOString()},{reason:'REPORT_TOO_EARLY',code:422}));
 assert.equal((await getReport(pool,'cycle-A')).status,'sent');
 await recordEvent(pool,message('ack',{target:outgoing[0].msgId}));
 assert.equal((await getReport(pool,'cycle-A')).status,'acknowledged');
 assert.equal(await runOnce(pool,async()=>assert.fail('ACK no debe generar nuevos envios'),at(19*60000)),false);
});
test('reinicio tras entrega incierta conserva idpk y snapshot; se limita a tres reintentos',async t=>{
 const {pool,options}=await fixture(t);const outgoing=[];
 const fail=async e=>{outgoing.push(e);throw Error('HTTP timeout despues de publicar');};
 await runOnce(pool,fail,opens);
 await recordEvent(pool,message('transfer',{quantity:99}));
 // New connection/worker has no in-memory knowledge of the previous attempt.
 const recovered=new Pool(options);
 try{
  for(let i=1;i<4;i++)await runOnce(recovered,fail,new Date(+opens+i*30000));
  await runOnce(recovered,fail,new Date(+opens+4*30000));
 }finally{await recovered.end();}
 assert.equal(outgoing.length,4);assert.equal(new Set(outgoing.map(e=>e.idpk)).size,1);
 assert.equal(new Set(outgoing.map(e=>e.msgId)).size,4);
 assert.ok(outgoing.every(e=>e.data.budgetBalance===500));
 assert.equal((await getReport(pool,'cycle-A')).status,'failed');
});
test('no envia despues del cierre y NACK detiene intentos',async t=>{
 const {pool}=await fixture(t);
 await runOnce(pool,async e=>{await recordEvent(pool,message('nack',{target:e.msgId,message:'invalid'},{reason:'MALFORMED_MESSAGE',code:422}));},opens);
 assert.equal((await getReport(pool,'cycle-A')).status,'failed');
 const second=status();second.cycleId='cycle-B';await recordEvent(pool,second);
 await runOnce(pool,async()=>assert.fail('No enviar en ventana cerrada'),closes);
 assert.equal((await getReport(pool,'cycle-B')).status,'expired');
});
test('timer apunta a fecha exacta sin redondear a tick; apagado no publica',async t=>{
 const {pool}=await fixture(t);let now=+opens-137;let pending;let sends=0;
 const worker=startWorker(pool,async()=>{sends++;},{enabled:true,clock:()=>now,setTimer:(fn,delay)=>{pending={fn,delay};return pending;},clearTimer:()=>{}});
 t.after(()=>worker.stop());
 assert.equal(pending.delay,0);await pending.fn();assert.equal(sends,0);assert.equal(pending.delay,137);
 now=+opens;await pending.fn();assert.equal(sends,1);worker.stop();
 const disabled=startWorker(pool,async()=>assert.fail('disabled'),{setTimer:()=>assert.fail('No timer while disabled')});
 disabled.wake();disabled.stop();
});
test('presupuesto del reporte incluye operaciones globales mas recientes, sin depender del ultimo evento del ciclo',async t=>{
 const {pool}=await fixture(t);
 await recordEvent(pool,message('transfer',{quantity:50},{cycleId:'cycle-B'}));
 let sent;await runOnce(pool,async e=>{sent=e;},opens);
 assert.equal(sent.data.budgetBalance,550);assert.equal(sent.data.energyBalance,-20);
});
test('bloquea reporte con negociaciones voluntarias que aun no se contabilizan',async t=>{
 const {pool}=await fixture(t);
 await recordEvent(pool,message('give',{energy:2,pricePerEnergy:1,target:randomUUID()}));
 await runOnce(pool,async()=>assert.fail('Saldo parcial'),opens);
 assert.equal((await getReport(pool,'cycle-A')).status,'blocked');
});
test('publisher conserva IDs persistidos y propiedad AMQP userId con confirmacion',async()=>{
 let body,properties;
 const publish=await createPublisher({createConfirmChannel:async()=>({on(){},publish(exchange,key,bytes,props,callback){
  assert.equal(exchange,'energy.x');assert.equal(key,'central');body=JSON.parse(bytes);properties=props;callback(null);
 }})});
 const e={type:'negotiation-report',cycleId:'cycle-A',idpk:randomUUID(),msgId:randomUUID(),timestamp:start.toISOString(),data:{budgetBalance:500,energyBalance:-20}};
 const result=await publish(e);assert.equal(result.msgId,e.msgId);assert.equal(body.timestamp,e.timestamp);assert.equal(properties.userId,'city.REE');
 await assert.rejects(publish({...e,msgId:e.idpk}),/distinto/);
});

test('ACK tardio despues de timeout HTTP detiene reintento; error de central conserva prioridad',async t=>{
 const {pool}=await fixture(t);let sent;
 await runOnce(pool,async e=>{sent=e;throw Error('lost HTTP response');},opens);
 await recordEvent(pool,message('ack',{target:sent.msgId}));
 assert.equal((await getReport(pool,'cycle-A')).status,'acknowledged');
 await recordEvent(pool,message('error',{target:sent.msgId,message:'early',opensAt:at(17*60000).toISOString()},{reason:'REPORT_TOO_EARLY',code:422}));
 await recordEvent(pool,message('ack',{target:sent.msgId}));
 const job=await getReport(pool,'cycle-A');assert.equal(job.status,'pending');assert.equal(+job.due_at,+at(17*60000));
});
test('migracion recupera status previo al scheduler y reapertura no duplica trabajos',async t=>{
 const {pool}=await fixture(t);
 await pool.query("DROP TABLE report_attempts; DROP TABLE report_jobs; DELETE FROM ledger_migrations WHERE name='003-reports.sql'");
 await migrate(pool);await migrate(pool);
 const jobs=await pool.query('SELECT * FROM report_jobs');assert.equal(jobs.rowCount,1);assert.equal(+jobs.rows[0].due_at,+opens);
});
