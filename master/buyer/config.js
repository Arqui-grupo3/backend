async function getConfig(db) {
  const { rows } = await db.query(`SELECT v.id AS version, v.span_seconds AS "spanSeconds", c.enabled
    FROM strategy_versions v CROSS JOIN buyer_control c ORDER BY v.id DESC LIMIT 1`);
  return rows[0];
}

async function setConfig(pool, { spanSeconds, enabled } = {}) {
  if ((spanSeconds === undefined && enabled === undefined) ||
      (spanSeconds !== undefined && (!Number.isSafeInteger(spanSeconds) || spanSeconds < 0 || spanSeconds >= 540)) ||
      (enabled !== undefined && typeof enabled !== 'boolean')) {
    const error = new Error('spanSeconds debe ser un entero entre 0 y 539; enabled debe ser booleano');
    error.statusCode = 422;
    throw error;
  }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // El mismo lock del status-statement fija el orden entre cambio y apertura.
    await db.query('SELECT pg_advisory_xact_lock(2173, 1)');
    if (spanSeconds !== undefined) await db.query('INSERT INTO strategy_versions (span_seconds) VALUES ($1)', [spanSeconds]);
    if (enabled !== undefined) {
      await db.query('UPDATE buyer_control SET enabled=$1, updated_at=clock_timestamp()', [enabled]);
      await db.query('INSERT INTO buyer_control_changes (enabled) VALUES ($1)', [enabled]);
    }
    const result = await getConfig(db);
    await db.query('COMMIT');
    return result;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

module.exports = { getConfig, setConfig };
