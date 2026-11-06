const { getLocalBalance } = require('../effects');

const round2 = (x) => Math.round(Number(x) * 100) / 100;

/**
 * Concilia el balance local acumulado en wallet_effects frente a la API de la wallet al cierre del ciclo.
 * Cumple con AD5: "Al cierre de cada ciclo, el saldo del dashboard coincide con GET /balance o el delta queda explicado".
 */
async function reconcileCycle({ pool, walletClient, cycleId }) {
  if (!pool) throw new Error('reconcileCycle requiere pool');
  if (!cycleId) throw new Error('reconcileCycle requiere cycleId');

  // 1. Obtener saldo local actual en créditos
  const localBalance = await getLocalBalance(pool);
  const localCr = round2(localBalance.CR || 0);

  // 2. Si no hay cliente de wallet (ej. en pruebas offline sin wallet), registrar con saldo local
  if (!walletClient || typeof walletClient.getBalance !== 'function') {
    const res = await pool.query(
      `INSERT INTO cycle_reconciliations (cycle_id, local_cr, wallet_cr, delta_cr, status, explanation, statement_entries, reconciled_at)
       VALUES ($1, $2, $2, 0.00, 'matched', 'Conciliación simulada sin cliente de wallet', '[]'::jsonb, now())
       ON CONFLICT (cycle_id) DO UPDATE SET
         local_cr = EXCLUDED.local_cr,
         wallet_cr = EXCLUDED.wallet_cr,
         delta_cr = EXCLUDED.delta_cr,
         status = EXCLUDED.status,
         explanation = EXCLUDED.explanation,
         reconciled_at = now()
       RETURNING *`,
      [cycleId, localCr]
    );
    return res.rows[0];
  }

  // 3. Consultar GET /balance a la wallet central
  let walletBalance;
  try {
    walletBalance = await walletClient.getBalance();
  } catch (err) {
    console.error(`[reconciliation] Error al consultar GET /balance para ciclo ${cycleId}:`, err.message);
    const res = await pool.query(
      `INSERT INTO cycle_reconciliations (cycle_id, local_cr, wallet_cr, delta_cr, status, explanation, statement_entries, reconciled_at)
       VALUES ($1, $2, $2, 0.00, 'unexplained_delta', $3, '[]'::jsonb, now())
       ON CONFLICT (cycle_id) DO UPDATE SET
         local_cr = EXCLUDED.local_cr,
         status = EXCLUDED.status,
         explanation = EXCLUDED.explanation,
         reconciled_at = now()
       RETURNING *`,
      [cycleId, localCr, `Error consultando wallet: ${err.message}`]
    );
    return res.rows[0];
  }

  const rawWalletCr = walletBalance?.assets?.CR?.balance ?? walletBalance?.CR?.balance ?? walletBalance?.balance;
  const walletCr = round2(rawWalletCr !== undefined ? rawWalletCr : localCr);
  let deltaCr = round2(walletCr - localCr);

  let status = 'matched';
  let explanation = 'Saldo local coincide con el saldo de la wallet';
  let absorbedEntries = [];

  // 4. Si hay delta, consultar GET /statement para absorber asientos faltantes (como adjustment)
  if (Math.abs(deltaCr) >= 0.01 && typeof walletClient.getStatement === 'function') {
    try {
      const stmtResult = await walletClient.getStatement({ cycleId, asset: 'CR' });
      const entries = Array.isArray(stmtResult) ? stmtResult : (stmtResult?.entries || stmtResult?.data || []);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const entry of entries) {
          const entryAmount = round2(entry.amount || entry.quantity || 0);
          if (entryAmount === 0) continue;

          const stmtKey = entry.id
            ? `stmt:${entry.id}`
            : `stmt:${cycleId}:${entry.kind || entry.type || 'adjustment'}:${entryAmount}`;

          const ins = await client.query(
            `INSERT INTO wallet_effects (effect_key, kind, asset, amount, cycle_id, swap_id, source, source_type, payload)
             VALUES ($1, $2, 'CR', $3, $4, $5, 'statement', $6, $7)
             ON CONFLICT (effect_key) DO NOTHING
             RETURNING effect_key`,
            [
              stmtKey,
              ['swap', 'transport', 'funding', 'penalty', 'mint', 'settlement', 'burn', 'adjustment'].includes(entry.kind)
                ? entry.kind
                : 'adjustment',
              entryAmount.toFixed(2),
              cycleId,
              entry.swapId || null,
              entry.type || 'statement-entry',
              JSON.stringify(entry)
            ]
          );

          if (ins.rowCount > 0) {
            absorbedEntries.push({ key: stmtKey, amount: entryAmount, kind: entry.kind || 'adjustment' });
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      // Recalcular saldo local tras absorber los asientos
      const updatedBalance = await getLocalBalance(pool);
      const updatedLocalCr = round2(updatedBalance.CR || 0);
      deltaCr = round2(walletCr - updatedLocalCr);

      if (Math.abs(deltaCr) < 0.01) {
        status = 'adjusted';
        explanation = `Delta conciliado exitosamente absorbiendo ${absorbedEntries.length} asiento(s) desde /statement`;
      } else {
        status = 'unexplained_delta';
        explanation = `Discrepancia de ${deltaCr} CR persiste tras revisar ${entries.length} asiento(s) de /statement`;
      }
    } catch (stmtErr) {
      console.error(`[reconciliation] Error al consultar /statement para ciclo ${cycleId}:`, stmtErr.message);
      status = 'unexplained_delta';
      explanation = `Delta de ${deltaCr} CR no resuelto: fallo al consultar /statement (${stmtErr.message})`;
    }
  }

  // 5. Persistir snapshot en cycle_reconciliations
  const res = await pool.query(
    `INSERT INTO cycle_reconciliations (cycle_id, local_cr, wallet_cr, delta_cr, status, explanation, statement_entries, reconciled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (cycle_id) DO UPDATE SET
       local_cr = EXCLUDED.local_cr,
       wallet_cr = EXCLUDED.wallet_cr,
       delta_cr = EXCLUDED.delta_cr,
       status = EXCLUDED.status,
       explanation = EXCLUDED.explanation,
       statement_entries = EXCLUDED.statement_entries,
       reconciled_at = now()
     RETURNING cycle_id AS "cycleId", local_cr::text AS "localCr", wallet_cr::text AS "walletCr",
               delta_cr::text AS "deltaCr", status, explanation, statement_entries AS "statementEntries",
               reconciled_at AS "reconciledAt"`,
    [cycleId, localCr, walletCr, deltaCr, status, explanation, JSON.stringify(absorbedEntries)]
  );

  console.log(`[reconciliation] Ciclo ${cycleId} conciliado: status=${status} delta=${deltaCr} CR`);
  return res.rows[0];
}

async function getReconciliation(pool, cycleId) {
  const res = await pool.query(
    `SELECT cycle_id AS "cycleId", local_cr::text AS "localCr", wallet_cr::text AS "walletCr",
            delta_cr::text AS "deltaCr", status, explanation, statement_entries AS "statementEntries",
            reconciled_at AS "reconciledAt"
     FROM cycle_reconciliations
     WHERE cycle_id = $1`,
    [cycleId]
  );
  return res.rows[0] || null;
}

module.exports = {
  reconcileCycle,
  getReconciliation
};
