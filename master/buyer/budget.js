// Presupuesto de compra según la línea de crédito de la wallet (enunciado, "1 · La wallet"):
// se puede comprar con saldo negativo hasta -creditLine; más allá la wallet rechaza el accept
// con INSUFFICIENT_ASSET. Antes de pedir, el comprador limita la cantidad a lo que alcanza a
// pagar, en vez de pedir el déficit entero y que la wallet rechace todo.
const Decimal = require('decimal.js').clone({ precision: 40 });

// Créditos comprometidos en bids que todavía no se liquidan: se pagarán al aceptar y aún no
// se ven descontados en /balance. Los liquidados ya están en el saldo.
async function committedCredits(db) {
  const { rows } = await db.query(`SELECT COALESCE(SUM(quantity * price_per_energy), 0)::text AS committed
    FROM buyer_bids WHERE status IN ('reserved', 'sent', 'accepted')`);
  return new Decimal(rows[0].committed);
}

// Cuántos kWh se pueden pagar: (available + creditLine - comprometido) / precio efectivo.
// Se usa el precio efectivo (precio + transporte) para que el transporte, que la central
// cobra después de liquidar, tampoco deje la cuenta fuera de la línea.
function affordableQuantity({ available, creditLine, committed = 0, unitPrice }) {
  const budget = new Decimal(available).plus(creditLine).minus(committed);
  const price = new Decimal(unitPrice);
  if (!budget.isFinite() || !price.isFinite() || price.lte(0) || budget.lte(0)) return 0;
  return budget.div(price).floor().toNumber();
}

// Devuelve el máximo de kWh comprables a ese precio, o null si no se pudo leer el saldo
// (en ese caso no se limita: la wallet sigue siendo la que decide).
async function maxAffordable(db, wallet, unitPrice) {
  if (!wallet || typeof wallet.getBalance !== 'function') return null;
  let balance;
  try {
    balance = await wallet.getBalance();
  } catch {
    return null;
  }
  const cr = balance?.assets?.CR;
  if (!cr || !Number.isFinite(Number(cr.available)) || !Number.isFinite(Number(cr.creditLine))) return null;
  const committed = await committedCredits(db);
  return affordableQuantity({ available: cr.available, creditLine: cr.creditLine, committed, unitPrice });
}

module.exports = { affordableQuantity, committedCredits, maxAffordable };
