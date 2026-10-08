const { randomUUID } = require('node:crypto');
const { getCycleState } = require('../ledger');

const MAX_ATTEMPTS = 4; // 1 initial + 3 retries
const TIMEOUT_MS = 30_000; // 30 seconds as specified in ADR 0003 & Enunciado

function round2(num) {
  return Math.round((Number(num) + Number.EPSILON) * 100) / 100;
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(2173, 1)');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Called within the event transaction, before COMMIT. No network calls here.
async function onEvent(client, event) {
  if (!event || typeof event !== 'object') return;

  // Correlate ACK
  if (event.type === 'ack' && event.data?.target) {
    const target = String(event.data.target).toLowerCase();
    await client.query('UPDATE negotiation_attempts SET ack_at=now() WHERE lower(msg_id::text)=$1', [target]);
    return;
  }

  // Correlate confirmation ('give' or 'take') from central
  if (['give', 'take'].includes(event.type) && event.data?.target) {
    const target = String(event.data.target).toLowerCase();
    const found = await client.query(
      `SELECT * FROM negotiation_jobs WHERE lower(last_msg_id::text)=$1 AND status='pending' FOR UPDATE`,
      [target]
    );
    const job = found.rows[0];
    if (job && job.direction === event.type) {
      const energyAgreed = Number(event.data.energy);
      const priceAgreed = Number(event.data.pricePerEnergy);
      const paymentAmount = round2(energyAgreed * priceAgreed);

      await client.query('UPDATE negotiation_attempts SET confirmed_at=now() WHERE lower(msg_id::text)=$1', [target]);

      if (job.direction === 'take') {
        // City buys energy -> city pays immediately.
        await client.query(
          `UPDATE negotiation_jobs SET status='confirmed', phase='payment_send',
           confirmation_msg_id=$2, energy_agreed=$3, price_agreed=$4, payment_amount=$5,
           due_at=now(), updated_at=now()
           WHERE idpk=$1`,
          [job.idpk, event.msgId, energyAgreed, priceAgreed, paymentAmount]
        );
      } else {
        // City sells energy ('give') -> wait up to 30s for central to pay.
        const dueAt = new Date(Date.now() + TIMEOUT_MS);
        await client.query(
          `UPDATE negotiation_jobs SET status='confirmed', phase='payment_wait',
           confirmation_msg_id=$2, energy_agreed=$3, price_agreed=$4, payment_amount=$5,
           due_at=$6, updated_at=now()
           WHERE idpk=$1`,
          [job.idpk, event.msgId, energyAgreed, priceAgreed, paymentAmount, dueAt]
        );
      }
    }
    return;
  }

  // Correlate central's payment transfer (becauseOf = confirmation_msg_id)
  if (event.type === 'transfer' && event.data?.becauseOf) {
    const becauseOf = String(event.data.becauseOf).toLowerCase();
    const found = await client.query(
      `SELECT * FROM negotiation_jobs WHERE lower(confirmation_msg_id::text)=$1 AND phase='payment_wait' FOR UPDATE`,
      [becauseOf]
    );
    const job = found.rows[0];
    if (job) {
      // Mark job as paid
      await client.query(
        `UPDATE negotiation_jobs SET status='paid', phase='completed', payment_msg_id=$2, updated_at=now()
         WHERE idpk=$1`,
        [job.idpk, event.msgId]
      );
      // Settle the 'give' in ledger_events so energy is deducted
      const giveEventRow = (await client.query(
        'SELECT id, idpk, received_at FROM events WHERE lower(msg_id::text)=$1',
        [String(job.confirmation_msg_id).toLowerCase()]
      )).rows[0];
      if (giveEventRow) {
        await client.query(
          `INSERT INTO ledger_events (id, idpk, msg_id, cycle_id, type, payload, envelope, occurred_at)
           VALUES ($1, $2, $3, $4, 'give', $5, $6, $7)
           ON CONFLICT (idpk) DO NOTHING`,
          [
            giveEventRow.id,
            giveEventRow.idpk,
            job.confirmation_msg_id,
            job.cycle_id,
            { energy: Number(job.energy_agreed), pricePerEnergy: Number(job.price_agreed), target: job.last_msg_id },
            {
              idpk: giveEventRow.idpk,
              msgId: job.confirmation_msg_id,
              type: 'give',
              cycleId: job.cycle_id,
              sender: 'central',
              data: { energy: Number(job.energy_agreed), pricePerEnergy: Number(job.price_agreed), target: job.last_msg_id },
              timestamp: event.timestamp || new Date().toISOString(),
            },
            event.timestamp || new Date().toISOString(),
          ]
        );
      }
    }
    return;
  }

  // Correlate error or nack
  if (['error', 'nack'].includes(event.type) && event.data?.target) {
    const target = String(event.data.target).toLowerCase();
    const found = await client.query(
      `SELECT * FROM negotiation_jobs WHERE lower(last_msg_id::text)=$1 AND status IN ('pending', 'confirmed') FOR UPDATE`,
      [target]
    );
    const job = found.rows[0];
    if (job) {
      await client.query(
        `UPDATE negotiation_attempts SET error_reason=$2, error_code=$3 WHERE lower(msg_id::text)=$1`,
        [target, event.reason || event.type, event.code || null]
      );

      if (event.reason === 'PRICE_ABOVE_CAP') {
        await client.query(
          `UPDATE negotiation_jobs SET status='failed', last_error='PRICE_ABOVE_CAP', cap=$2, updated_at=now() WHERE idpk=$1`,
          [job.idpk, event.data.cap ?? null]
        );
      } else if (event.reason === 'OVER_CAPACITY') {
        await client.query(
          `UPDATE negotiation_jobs SET status='failed', last_error='OVER_CAPACITY', spare=$2, updated_at=now() WHERE idpk=$1`,
          [job.idpk, event.data.spare ?? null]
        );
      } else if (event.reason === 'CYCLE_EXPIRED') {
        await client.query(
          `UPDATE negotiation_jobs SET status='expired', last_error='CYCLE_EXPIRED', updated_at=now() WHERE idpk=$1`,
          [job.idpk]
        );
      } else {
        await client.query(
          `UPDATE negotiation_jobs SET status='failed', last_error=$2, updated_at=now() WHERE idpk=$1`,
          [job.idpk, `${event.type}: ${event.reason || 'error'}`]
        );
      }
    }
  }
}

async function claim(pool, now = new Date()) {
  return transaction(pool, async (client) => {
    // 1. Mark expired jobs that exceeded attempts on timeout
    await client.query(
      `UPDATE negotiation_jobs SET status='expired', last_error='Timeout limit reached (30s)', updated_at=$1
       WHERE status IN ('pending', 'confirmed') AND attempts >= $2 AND due_at <= $1`,
      [now, MAX_ATTEMPTS]
    );

    // 2. Select next actionable job
    const result = await client.query(
      `SELECT * FROM negotiation_jobs
       WHERE status IN ('pending', 'confirmed') AND due_at <= $1
       ORDER BY due_at, created_at
       LIMIT 1 FOR UPDATE`,
      [now]
    );
    const job = result.rows[0];
    if (!job) return null;

    // Check if max attempts reached
    if (job.attempts >= MAX_ATTEMPTS && job.phase !== 'payment_send') {
      await client.query(
        `UPDATE negotiation_jobs SET status='expired', last_error='Retry limit reached', updated_at=$1 WHERE idpk=$2`,
        [now, job.idpk]
      );
      return null;
    }

    // Case A: Proposal / Retry Proposal
    if (job.phase === 'proposal') {
      const msgId = randomUUID();
      const envelope = {
        idpk: job.idpk, // Idempotency key MUST remain unchanged across retries!
        msgId,
        type: 'negotiation-proposal',
        timestamp: now.toISOString(),
        cityId: 'REE',
        cycleId: job.cycle_id,
        data: {
          direction: job.direction,
          quantity: Number(job.quantity),
          pricePerEnergy: Number(job.price_per_energy),
        },
      };

      await client.query(
        `INSERT INTO negotiation_attempts(msg_id, idpk, attempt, phase, envelope, scheduled_at, started_at)
         VALUES ($1, $2, $3, 'proposal', $4, $5, $6)`,
        [msgId, job.idpk, job.attempts + 1, envelope, job.due_at, now]
      );

      await client.query(
        `UPDATE negotiation_jobs SET attempts = attempts + 1, last_msg_id = $2,
         due_at = $3, updated_at = $4 WHERE idpk = $1`,
        [job.idpk, msgId, new Date(+now + TIMEOUT_MS), now]
      );

      return { action: 'publish_proposal', envelope, job };
    }

    // Case B: City pays for a confirmed 'take'
    if (job.phase === 'payment_send') {
      const transferIdpk = randomUUID();
      const transferMsgId = randomUUID();
      const transferEnvelope = {
        idpk: transferIdpk,
        msgId: transferMsgId,
        type: 'transfer',
        timestamp: now.toISOString(),
        cityId: 'REE',
        cycleId: job.cycle_id,
        data: {
          becauseOf: job.confirmation_msg_id,
          quantity: Number(job.payment_amount),
        },
      };

      await client.query(
        `INSERT INTO negotiation_attempts(msg_id, idpk, attempt, phase, envelope, scheduled_at, started_at)
         VALUES ($1, $2, $3, 'payment_send', $4, $5, $6)`,
        [transferMsgId, job.idpk, job.attempts, transferEnvelope, job.due_at, now]
      );

      return { action: 'publish_payment', envelope: transferEnvelope, job };
    }

    // Case C: 30s timeout waiting for central's payment in 'give'
    if (job.phase === 'payment_wait') {
      // "Si no llega, asuman que no hubo operacion real y reintenten la operacion con el mismo idpk."
      if (job.attempts < MAX_ATTEMPTS) {
        const msgId = randomUUID();
        const envelope = {
          idpk: job.idpk, // Same idpk
          msgId,
          type: 'negotiation-proposal',
          timestamp: now.toISOString(),
          cityId: 'REE',
          cycleId: job.cycle_id,
          data: {
            direction: job.direction,
            quantity: Number(job.quantity),
            pricePerEnergy: Number(job.price_per_energy),
          },
        };

        await client.query(
          `INSERT INTO negotiation_attempts(msg_id, idpk, attempt, phase, envelope, scheduled_at, started_at)
           VALUES ($1, $2, $3, 'proposal', $4, $5, $6)`,
          [msgId, job.idpk, job.attempts + 1, envelope, job.due_at, now]
        );

        await client.query(
          `UPDATE negotiation_jobs SET status='pending', phase='proposal',
           attempts = attempts + 1, last_msg_id = $2, due_at = $3, updated_at = $4
           WHERE idpk = $1`,
          [job.idpk, msgId, new Date(+now + TIMEOUT_MS), now]
        );

        return { action: 'publish_proposal', envelope, job };
      } else {
        await client.query(
          `UPDATE negotiation_jobs SET status='expired', last_error='Central payment timeout after max retries', updated_at=$1
           WHERE idpk=$2`,
          [now, job.idpk]
        );
        return null;
      }
    }

    return null;
  });
}

async function runOnce(pool, publish, now = new Date()) {
  const claimed = await claim(pool, now);
  if (!claimed) return false;

  const { action, envelope, job } = claimed;

  if (action === 'publish_proposal') {
    try {
      await publish(envelope);
      await transaction(pool, async (client) => {
        await client.query('UPDATE negotiation_attempts SET published_at=now() WHERE msg_id=$1', [envelope.msgId]);
        // Also persist proposal to events table for unified history
        await client.query(
          `INSERT INTO events(id, idpk, msg_id, type, cycle_id, package_body, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (idpk) DO NOTHING`,
          [randomUUID(), envelope.idpk, envelope.msgId, envelope.type, envelope.cycleId, envelope.data, envelope.timestamp]
        );
      });
    } catch (err) {
      await transaction(pool, async (client) => {
        await client.query('UPDATE negotiation_attempts SET publish_error=$2 WHERE msg_id=$1', [
          envelope.msgId,
          String(err.message).slice(0, 1000),
        ]);
      });
    }
    return true;
  }

  if (action === 'publish_payment') {
    try {
      await publish(envelope);
      await transaction(pool, async (client) => {
        await client.query('UPDATE negotiation_attempts SET published_at=now() WHERE msg_id=$1', [envelope.msgId]);
        await client.query(
          `UPDATE negotiation_jobs SET status='paid', phase='completed', payment_msg_id=$2, updated_at=now()
           WHERE idpk=$1`,
          [job.idpk, envelope.msgId]
        );

        // Record outgoing transfer in events and ledger_events (discounts budget)
        const eventId = randomUUID();
        await client.query(
          `INSERT INTO events(id, idpk, msg_id, type, cycle_id, package_body, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [eventId, envelope.idpk, envelope.msgId, envelope.type, envelope.cycleId, envelope.data, envelope.timestamp]
        );
        await client.query(
          `INSERT INTO ledger_events(id, idpk, msg_id, cycle_id, type, payload, envelope, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [eventId, envelope.idpk, envelope.msgId, envelope.cycleId, envelope.type, envelope.data, envelope, envelope.timestamp]
        );

        // Record confirmed take in ledger_events (increases energy)
        const takeEventRow = (await client.query(
          'SELECT id, idpk, received_at FROM events WHERE lower(msg_id::text)=$1',
          [String(job.confirmation_msg_id).toLowerCase()]
        )).rows[0];
        if (takeEventRow) {
          await client.query(
            `INSERT INTO ledger_events(id, idpk, msg_id, cycle_id, type, payload, envelope, occurred_at)
             VALUES ($1, $2, $3, $4, 'take', $5, $6, $7)
             ON CONFLICT (idpk) DO NOTHING`,
            [
              takeEventRow.id,
              takeEventRow.idpk,
              job.confirmation_msg_id,
              job.cycle_id,
              { energy: Number(job.energy_agreed), pricePerEnergy: Number(job.price_agreed), target: job.last_msg_id },
              {
                idpk: takeEventRow.idpk,
                msgId: job.confirmation_msg_id,
                type: 'take',
                cycleId: job.cycle_id,
                sender: 'central',
                data: { energy: Number(job.energy_agreed), pricePerEnergy: Number(job.price_agreed), target: job.last_msg_id },
                timestamp: envelope.timestamp,
              },
              envelope.timestamp,
            ]
          );
        }
      });
    } catch (err) {
      await transaction(pool, async (client) => {
        await client.query('UPDATE negotiation_attempts SET publish_error=$2 WHERE msg_id=$1', [
          envelope.msgId,
          String(err.message).slice(0, 1000),
        ]);
      });
    }
    return true;
  }

  return false;
}

function startWorker(
  pool,
  publish,
  { enabled = true, clock = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}
) {
  let timer,
    running = false,
    stopped = false,
    wakePending = false;
  const health = { enabled, startedAt: new Date(clock()).toISOString(), lastTick: null, lastError: null };
  const schedule = (delay) => {
    clearTimer(timer);
    timer = setTimer(tick, Math.max(0, delay));
    timer?.unref?.();
  };

  async function tick() {
    if (stopped || !enabled) return;
    if (running) {
      wakePending = true;
      return;
    }
    running = true;
    wakePending = false;
    let delay = 1000;
    try {
      for (let i = 0; i < 20; i++) {
        if (!(await runOnce(pool, publish, new Date(clock())))) break;
      }
      health.lastTick = new Date(clock()).toISOString();
      health.lastError = null;

      const result = await pool.query(
        "SELECT MIN(due_at) AS deadline FROM negotiation_jobs WHERE status IN ('pending', 'confirmed')"
      );
      const next = result.rows[0]?.deadline;
      if (next) delay = Math.min(1000, Math.max(0, +next - clock()));
    } catch (err) {
      health.lastError = err.message;
      console.error('[negotiations]', err.message);
    } finally {
      running = false;
      if (!stopped) schedule(wakePending ? 0 : delay);
    }
  }

  if (enabled) schedule(0);
  return {
    health,
    wake() {
      if (enabled && !stopped) {
        if (running) wakePending = true;
        else schedule(0);
      }
    },
    stop() {
      stopped = true;
      clearTimer(timer);
    },
  };
}

async function createProposal(pool, { cycleId, direction, quantity, pricePerEnergy }) {
  if (!cycleId || typeof cycleId !== 'string' || !cycleId.trim()) throw new Error('cycleId requerido');
  if (!['give', 'take'].includes(direction)) throw new Error("direction debe ser 'give' o 'take'");
  const q = Number(quantity);
  const p = Number(pricePerEnergy);
  if (!Number.isFinite(q) || q <= 0) throw new Error('quantity debe ser un numero positivo');
  if (!Number.isFinite(p) || p < 0) throw new Error('pricePerEnergy debe ser no negativo');

  const idpk = randomUUID();
  const now = new Date();

  await pool.query(
    `INSERT INTO negotiation_jobs (idpk, cycle_id, direction, quantity, price_per_energy, status, phase, attempts, due_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', 'proposal', 0, $6, $7, $7)`,
    [idpk, cycleId, direction, q, p, now, now]
  );

  return { idpk, cycleId, direction, quantity: q, pricePerEnergy: p, status: 'pending' };
}

async function getNegotiations(pool, { cycleId, limit = 25 } = {}) {
  const values = [];
  let where = '';
  if (cycleId) {
    values.push(cycleId);
    where = 'WHERE cycle_id = $1';
  }
  values.push(Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100));

  const result = await pool.query(
    `SELECT idpk, cycle_id AS "cycleId", direction, quantity, price_per_energy AS "pricePerEnergy",
            status, phase, attempts, due_at AS "dueAt", last_msg_id AS "lastMsgId",
            confirmation_msg_id AS "confirmationMsgId", payment_msg_id AS "paymentMsgId",
            energy_agreed AS "energyAgreed", price_agreed AS "priceAgreed",
            payment_amount AS "paymentAmount", last_error AS "lastError",
            cap, spare, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM negotiation_jobs
     ${where}
     ORDER BY created_at DESC
     LIMIT $${values.length}`,
    values
  );

  return result.rows;
}

module.exports = {
  onEvent,
  claim,
  runOnce,
  startWorker,
  createProposal,
  getNegotiations,
};
