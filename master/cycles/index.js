/**
 * master/cycles/index.js
 * Detalle enriquecido de ciclos para RF01 (Historial de Ciclos y Auditoría).
 */

async function getCycleDetail(pool, cycleId) {
  if (!cycleId) return null;

  // 1. Eventos del ciclo
  const eventsRes = await pool.query(
    `SELECT id, idpk, msg_id AS "msgId", type, cycle_id AS "cycleId",
            package_body AS "data", received_at AS "receivedAt", seq
     FROM events
     WHERE cycle_id = $1
     ORDER BY seq ASC`,
    [cycleId]
  );

  // 2. Ofertas de venta del ciclo
  const offersRes = await pool.query(
    `SELECT offer_id AS "offerId", total_quantity AS "totalQuantity",
            price_per_energy AS "pricePerEnergy", status,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM seller_offers
     WHERE cycle_id = $1
     ORDER BY created_at ASC`,
    [cycleId]
  );

  // 3. Bids recibidos/procesados en el ciclo
  const bidsRes = await pool.query(
    `SELECT idpk, offer_id AS "offerId", buyer_city_id AS "buyerCity",
            requested_quantity AS "quantity", price_per_energy AS "pricePerEnergy",
            status, swap_id AS "swapId", rejection_reason AS "rejectionReason",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM seller_bids
     WHERE cycle_id = $1
     ORDER BY created_at ASC`,
    [cycleId]
  );

  // 4. Operaciones de wallet (swaps propuestos o aceptados)
  const walletOpsRes = await pool.query(
    `SELECT idpk, operation, swap_id AS "swapId", status,
            attempts, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM wallet_ops
     WHERE swap_id IN (SELECT swap_id FROM seller_bids WHERE cycle_id = $1 AND swap_id IS NOT NULL)
        OR idpk IN (SELECT swap_idpk FROM seller_bids WHERE cycle_id = $1 AND swap_idpk IS NOT NULL)
     ORDER BY created_at ASC`,
    [cycleId]
  );

  // 5. Efectos contables y transporte
  const effectsRes = await pool.query(
    `SELECT effect_key AS "effectKey", kind, asset, amount, source, source_type AS "sourceType", applied_at AS "appliedAt"
     FROM wallet_effects
     WHERE cycle_id = $1
     ORDER BY seq ASC`,
    [cycleId]
  );

  // 6. Conciliación
  const reconRes = await pool.query(
    `SELECT cycle_id AS "cycleId", local_cr AS "localBalance",
            wallet_cr AS "remoteBalance", delta_cr AS "delta", status,
            reconciled_at AS "checkedAt"
     FROM cycle_reconciliations
     WHERE cycle_id = $1`,
    [cycleId]
  );

  const events = eventsRes.rows;

  if (events.length === 0 && offersRes.rowCount === 0 && bidsRes.rowCount === 0) {
    return null;
  }

  // Filtrar eventos por tipo
  const statusStatements = events.filter((e) => e.type === 'status-statement').map((e) => e.data);
  const transfers = events.filter((e) => e.type === 'transfer').map((e) => e.data);
  const demandStatements = events.filter((e) => e.type === 'demand-statement').map((e) => e.data);
  const imbalanceSettlements = events.filter((e) => e.type === 'imbalance-settlement').map((e) => e.data);
  const negotiationReports = events.filter((e) => e.type === 'negotiation-report').map((e) => e.data);
  const offerUpdatedEvents = events.filter((e) => e.type === 'offer-updated').map((e) => e.data);

  // Calcular transporte cobrado desde wallet_effects
  let transportChargedCredits = 0;
  for (const eff of effectsRes.rows) {
    if (eff.kind === 'transport' && eff.asset === 'CR') {
      transportChargedCredits += Math.abs(Number(eff.amount));
    }
  }

  // Identificar la última operación
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const lastOperation = lastEvent ? {
    type: lastEvent.type,
    receivedAt: lastEvent.receivedAt,
    seq: lastEvent.seq,
    summary: lastEvent.type,
    data: lastEvent.data,
  } : null;

  return {
    cycleId,
    operationCount: events.length,
    startedAt: events[0]?.receivedAt || null,
    lastOperationAt: lastEvent?.receivedAt || null,
    lastOperationType: lastEvent?.type || null,
    lastOperation,
    statusStatements,
    transfers,
    demandStatements,
    sellerOffers: offersRes.rows,
    offerUpdates: offerUpdatedEvents,
    sellerBids: bidsRes.rows,
    walletOperations: walletOpsRes.rows,
    walletEffects: effectsRes.rows,
    transportChargedCredits: Math.round(transportChargedCredits * 100) / 100,
    imbalanceSettlements,
    negotiationReports,
    finalBalances: negotiationReports[0] || null,
    reconciliation: reconRes.rows[0] || null,
  };
}

module.exports = {
  getCycleDetail,
};
