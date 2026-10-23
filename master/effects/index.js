const { onWalletEvent } = require('../wallet');

const CITY_ID = process.env.CITY_ID || 'REE';

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const round2 = (x) => Math.round(x * 100) / 100;

function effectsFor(event, city = CITY_ID) {
  if (!event || event.sender !== 'central' || !event.data || typeof event.data !== 'object') return [];
  const d = event.data;
  const cycleId = typeof event.cycleId === 'string' ? event.cycleId : null;
  const base = { cycleId, sourceType: event.type, sourceIdpk: event.idpk ?? null };

  switch (event.type) {
    case 'swap-settled': {
      if (!d.swapId || !d.give || !d.take) return [];
      let sign;
      if (d.proposer === city) sign = { give: -1, take: 1 };
      else if (d.acceptor === city) sign = { give: 1, take: -1 }; 
      else return [];
      return [d.give, d.take].map((leg, i) => {
        const s = i === 0 ? sign.give : sign.take;
        return { ...base, key: `swap:${d.swapId}:${leg.asset}`, kind: 'swap', asset: leg.asset, amount: s * leg.amount, swapId: d.swapId };
      }).filter((e) => (e.asset === 'CR' || e.asset === 'KWH') && finite(e.amount));
    }

    case 'trade-recorded': {
      if (d.buyer !== city || !d.swapId || !finite(d.transportTotal)) return [];
      return [{ ...base, key: `transport:${d.swapId}`, kind: 'transport', asset: 'CR', amount: -d.transportTotal, swapId: d.swapId }];
    }

    case 'transfer': {
      if (!cycleId || !finite(d.quantity)) return [];
      const penalty = d.penalty && finite(d.penalty.amount) ? d.penalty : null;
      const gross = round2(d.quantity + (penalty ? penalty.amount : 0));
      const out = [{ ...base, key: `funding:${cycleId}`, kind: 'funding', asset: 'CR', amount: gross }];
      if (penalty) {
        const forCycle = penalty.forCycleId || cycleId;
        out.push({ ...base, cycleId: forCycle, key: `penalty:${forCycle}`, kind: 'penalty', asset: 'CR', amount: -penalty.amount });
      }
      return out;
    }

    case 'status-statement': {
      const sellable = d.energy?.sellable;
      if (!cycleId || !Number.isInteger(sellable) || sellable <= 0) return [];
      return [{ ...base, key: `mint:${cycleId}`, kind: 'mint', asset: 'KWH', amount: sellable }];
    }

    case 'imbalance-settlement': {
      if (!cycleId) return [];
      const out = [];
      if (finite(d.total)) out.push({ ...base, key: `settlement:${cycleId}`, kind: 'settlement', asset: 'CR', amount: d.total });
      if (finite(d.kwhHeld) && d.kwhHeld > 0) out.push({ ...base, key: `burn:${cycleId}`, kind: 'burn', asset: 'KWH', amount: -d.kwhHeld });
      return out;
    }

    default:
      return [];
  }
}

async function onEvent(client, event, { city = CITY_ID } = {}) {
  const effects = effectsFor(event, city);
  let applied = 0;
  for (const e of effects) {
    const result = await client.query(
      `INSERT INTO wallet_effects (effect_key, kind, asset, amount, cycle_id, swap_id, source, source_type, source_idpk, payload)
       VALUES ($1, $2, $3, $4, $5, $6, 'event', $7, $8, $9)
       ON CONFLICT (effect_key) DO NOTHING`,
      [e.key, e.kind, e.asset, e.amount.toFixed(2), e.cycleId, e.swapId ?? null, e.sourceType, e.sourceIdpk, JSON.stringify(event.data)]
    );
    applied += result.rowCount;
  }
  await onWalletEvent(client, event);
  return { effects: effects.length, applied };
}

async function getLocalBalance(db) {
  const { rows } = await db.query('SELECT asset, balance::text AS balance, last_seq::text AS last_seq FROM wallet_local_balance');
  const out = { CR: '0.00', KWH: '0.00', lastSeq: null };
  for (const row of rows) {
    out[row.asset] = row.balance;
    if (!out.lastSeq || BigInt(row.last_seq) > BigInt(out.lastSeq)) out.lastSeq = row.last_seq;
  }
  return out;
}

async function getCycleEffects(db, cycleId) {
  const { rows } = await db.query(
    `SELECT effect_key AS "effectKey", kind, asset, amount::text AS amount, swap_id AS "swapId",
            source, source_type AS "sourceType", applied_at AS "appliedAt"
     FROM wallet_effects WHERE cycle_id = $1 ORDER BY seq`,
    [cycleId]
  );
  return rows;
}

module.exports = { effectsFor, onEvent, getLocalBalance, getCycleEffects };
