const Decimal = require('decimal.js').clone({ precision: 40 });
const { calculateTransportPerEnergy } = require('../market/selection');
const { getLatestDistanceTable } = require('../market');

async function committedCredits(db, distanceTable = null) {
  const { rows: pending } = await db.query(
    `SELECT quantity, price_per_energy, seller_city_id
     FROM buyer_bids
     WHERE status IN ('reserved', 'sent', 'accepted')`
  );

  if (!pending.length) return new Decimal(0);

  const table = distanceTable ?? (await getLatestDistanceTable(db))?.data;
  let committed = new Decimal(0);

  for (const bid of pending) {
    const transport = calculateTransportPerEnergy(table, bid.seller_city_id);

    if (transport === null) {
      throw new Error(
        `No se puede estimar el transporte pendiente desde ${bid.seller_city_id}`
      );
    }

    committed = committed.plus(
      new Decimal(bid.price_per_energy).plus(transport).times(bid.quantity)
    );
  }

  return committed;
}

function affordableQuantity({ available, creditLine, committed = 0, unitPrice }) {
  const budget = new Decimal(available).plus(creditLine).minus(committed);
  const price = new Decimal(unitPrice);
  if (!budget.isFinite() || !price.isFinite() || price.lte(0) || budget.lte(0)) return 0;
  return budget.div(price).floor().toNumber();
}

async function maxAffordable(db, wallet, unitPrice, distanceTable = null) {
  if (!wallet || typeof wallet.getBalance !== 'function') return null;
  let balance;
  try {
    balance = await wallet.getBalance();
  } catch {
    return null;
  }
  const cr = balance?.assets?.CR;
  if (!cr || !Number.isFinite(Number(cr.available)) || !Number.isFinite(Number(cr.creditLine))) return null;
  const committed = await committedCredits(db, distanceTable);
  return affordableQuantity({ available: cr.available, creditLine: cr.creditLine, committed, unitPrice });
}

module.exports = { affordableQuantity, committedCredits, maxAffordable };
