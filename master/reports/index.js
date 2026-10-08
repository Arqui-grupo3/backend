const { randomUUID } = require('node:crypto');
const { getCycleState } = require('../ledger');
const MAX_ATTEMPTS = 4;
const RESPONSE_TIMEOUT = 30_000;
const WINDOW = 5 * 60_000;

// Called inside the event transaction, before COMMIT. No network calls here.
async function onEvent(client, event) {
  if (event.type === 'status-statement') {
    const closesAt = new Date(event.data.validUntil);
    await client.query(`INSERT INTO report_jobs(cycle_id,idpk,due_at,closes_at,source_timestamp)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT(cycle_id) DO UPDATE SET
      due_at=EXCLUDED.due_at, closes_at=EXCLUDED.closes_at, source_timestamp=EXCLUDED.source_timestamp
      WHERE report_jobs.attempts=0 AND report_jobs.status='pending'
        AND EXCLUDED.source_timestamp >= report_jobs.source_timestamp`,
    [event.cycleId,randomUUID(),new Date(+closesAt-WINDOW),closesAt,event.timestamp]);
    return;
  }
  if (!['ack','nack','error'].includes(event.type) || event.sender !== 'central') return;
  const target = event.data?.target;
  if (typeof target !== 'string') return;
  const found = await client.query(`SELECT j.*,a.error_reason AS response_reason FROM report_jobs j JOIN report_attempts a USING(cycle_id)
    WHERE a.msg_id::text=$1 FOR UPDATE OF j`, [target.toLowerCase()]);
  const job = found.rows[0];
  if (!job || job.last_msg_id !== target.toLowerCase()) return;
  if (event.cycleId && event.cycleId !== job.cycle_id) return;
  if (event.type === 'ack') {
    await client.query('UPDATE report_attempts SET ack_at=now() WHERE msg_id=$1',[target]);
    // Do not undo an earlier error if response ordering changes.
    await client.query(`UPDATE report_jobs SET status='acknowledged',updated_at=now()
      WHERE cycle_id=$1 AND status IN ('sending','sent','pending') AND $2::text IS NULL`,[job.cycle_id,job.response_reason]);
    return;
  }
  if (!['sending','sent','acknowledged','pending'].includes(job.status) || job.response_reason) return;
  await client.query('UPDATE report_attempts SET error_reason=$2 WHERE msg_id=$1',[target,event.reason || event.type]);
  const opensAt = new Date(event.data?.opensAt);
  if (event.type === 'error' && event.reason === 'REPORT_TOO_EARLY' &&
      typeof event.data?.opensAt === 'string' && Number.isFinite(+opensAt) && +opensAt < +job.closes_at && job.attempts < MAX_ATTEMPTS) {
    await client.query(`UPDATE report_jobs SET status='pending',due_at=$2,payload=NULL,snapshot_seq=NULL,
      last_error='REPORT_TOO_EARLY',updated_at=now() WHERE cycle_id=$1`,[job.cycle_id,opensAt]);
  } else {
    await client.query(`UPDATE report_jobs SET status='failed',last_error=$2,updated_at=now() WHERE cycle_id=$1`,
      [job.cycle_id,`${event.type}: ${event.reason || 'invalid response'}`]);
  }
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(2173, 1)');
    const result = await work(client);
    await client.query('COMMIT'); return result;
  } catch(err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

async function claim(pool, now) {
  return transaction(pool, async client => {
    await client.query(`UPDATE report_jobs SET status='expired',last_error='Window closed',updated_at=$1
      WHERE status IN ('pending','sending','sent') AND closes_at <= $1`,[now]);
    const result = await client.query(`SELECT * FROM report_jobs
      WHERE status IN ('pending','sending','sent') AND due_at <= $1 AND closes_at > $1
      ORDER BY due_at,cycle_id LIMIT 1 FOR UPDATE`,[now]);
    const job = result.rows[0]; if (!job) return null;
    if (job.attempts >= MAX_ATTEMPTS) {
      await client.query("UPDATE report_jobs SET status='failed',last_error='Retry limit reached',updated_at=$2 WHERE cycle_id=$1",[job.cycle_id,now]);
      return null;
    }
    if (!job.payload) {
      const state = await getCycleState(client,job.cycle_id);
      // Partial or in-flight negotiations must not silently report partial balances.
      const unsupported = await client.query(`
        SELECT 1 FROM events e
        WHERE e.type IN ('negotiation-proposal','give','take')
          AND NOT EXISTS (
            SELECT 1 FROM negotiation_jobs j
            WHERE (j.last_msg_id = e.msg_id OR j.confirmation_msg_id = e.msg_id)
              AND j.status IN ('paid', 'failed', 'expired')
          )
        LIMIT 1
      `);
      if (!state?.initialized || unsupported.rowCount) {
        await client.query("UPDATE report_jobs SET status='blocked',last_error=$2,updated_at=$3 WHERE cycle_id=$1",
          [job.cycle_id,unsupported.rowCount ? 'Voluntary negotiations not accounted for' : 'Missing status-statement',now]);
        return null;
      }
      const latest = (await client.query('SELECT budget_balance,last_operation_seq FROM cycle_state ORDER BY last_operation_seq DESC LIMIT 1')).rows[0];
      const budgetBalance = Number(latest.budget_balance), energyBalance = Number(state.energyBalance);
      if (![budgetBalance,energyBalance].every(n=>Number.isFinite(n) && Math.abs(n)<=Number.MAX_SAFE_INTEGER)) {
        await client.query("UPDATE report_jobs SET status='blocked',last_error='Balance outside JSON numeric range' WHERE cycle_id=$1",[job.cycle_id]);
        return null;
      }
      job.payload = {budgetBalance,energyBalance}; job.snapshot_seq = latest.last_operation_seq;
    }
    const envelope = {idpk:job.idpk,msgId:randomUUID(),type:'negotiation-report',timestamp:now.toISOString(),cityId:'REE',cycleId:job.cycle_id,data:job.payload};
    await client.query(`INSERT INTO report_attempts(msg_id,cycle_id,attempt,envelope,snapshot_seq,scheduled_at,started_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,[envelope.msgId,job.cycle_id,job.attempts+1,envelope,job.snapshot_seq,job.due_at,now]);
    await client.query(`UPDATE report_jobs SET status='sending',attempts=attempts+1,last_msg_id=$2,
      payload=$3,snapshot_seq=$4,due_at=$5,updated_at=$6 WHERE cycle_id=$1`,
      [job.cycle_id,envelope.msgId,job.payload,job.snapshot_seq,new Date(+now+RESPONSE_TIMEOUT),now]);
    return { envelope, closesAt: job.closes_at };
  });
}

async function runOnce(pool, publish, now = new Date()) {
  const began = Date.now();
  const claimed = await claim(pool,now);
  if (!claimed) return false;
  const { envelope, closesAt } = claimed;
  // Recheck after DB work: a lock wait may have crossed the deadline.
  if (+now + Date.now() - began >= +closesAt) {
    await transaction(pool, client => client.query(
      "UPDATE report_jobs SET status='expired',last_error='Window closed before publication' WHERE cycle_id=$1 AND last_msg_id=$2 AND status='sending'",
      [envelope.cycleId,envelope.msgId]));
    return false;
  }
  try {
    // The publisher must honor the persisted msgId; responses can arrive now.
    await publish(envelope);
    await transaction(pool, async client => {
      await client.query('UPDATE report_attempts SET published_at=now() WHERE msg_id=$1',[envelope.msgId]);
      await client.query(`UPDATE report_jobs SET status='sent',updated_at=now()
        WHERE cycle_id=$1 AND last_msg_id=$2 AND status='sending'`,[envelope.cycleId,envelope.msgId]);
    });
  } catch (err) {
    await transaction(pool, async client => {
      await client.query('UPDATE report_attempts SET publish_error=$2 WHERE msg_id=$1',[envelope.msgId,String(err.message).slice(0,1000)]);
      await client.query(`UPDATE report_jobs SET status='pending',last_error=$3,updated_at=now()
        WHERE cycle_id=$1 AND last_msg_id=$2 AND status='sending'`,[envelope.cycleId,envelope.msgId,String(err.message).slice(0,1000)]);
    });
  }
  return true;
}

// A deadline timer, not a fixed 5-second polling delay. Reconcile each second
// for new jobs created by another instance; local events wake immediately.
function startWorker(pool,publish,{enabled=false,clock=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  let timer, running=false, stopped=false, wakePending=false;
  const health={enabled,startedAt:new Date(clock()).toISOString(),lastTick:null,lastError:null};
  const schedule=delay=>{clearTimer(timer);timer=setTimer(tick,Math.max(0,delay));timer?.unref?.();};
  async function tick() {
    if(stopped || !enabled)return;
    if(running){wakePending=true;return;}
    running=true; wakePending=false; let delay=1000;
    try {
      for(let i=0;i<20;i++){if(!await runOnce(pool,publish,new Date(clock())))break;}
      health.lastTick=new Date(clock()).toISOString(); health.lastError=null;
      const result=await pool.query("SELECT MIN(LEAST(due_at,closes_at)) AS deadline FROM report_jobs WHERE status IN ('pending','sending','sent')");
      const next=result.rows[0].deadline;
      if(next)delay=Math.min(1000,Math.max(0,+next-clock()));
    } catch(err) {health.lastError=err.message;console.error('[reports]',err.message);}
    finally {running=false;if(!stopped)schedule(wakePending?0:delay);}
  }
  if(enabled)schedule(0);
  return {health,wake(){if(enabled&&!stopped){if(running)wakePending=true;else schedule(0);}},stop(){stopped=true;clearTimer(timer);}};
}
async function getReport(pool,cycleId) {
  const result=await pool.query('SELECT * FROM report_jobs WHERE cycle_id=$1',[cycleId]);
  if(!result.rowCount)return null;
  const attempts=await pool.query('SELECT * FROM report_attempts WHERE cycle_id=$1 ORDER BY attempt',[cycleId]);
  return {...result.rows[0],attempts:attempts.rows,attemptCount:result.rows[0].attempts};
}
module.exports={onEvent,runOnce,startWorker,getReport};
