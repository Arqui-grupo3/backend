
const fs = require('fs');

const HEALTH_FILE = process.env.HEALTH_FILE || '/tmp/connector-healthy';
const MAX_AGE_MS = 60_000; // el heartbeat se escribe cada 15s

try {
  const stats = fs.statSync(HEALTH_FILE);
  const age = Date.now() - stats.mtimeMs;

  if (age > MAX_AGE_MS) {
    console.error(`[healthcheck] heartbeat obsoleto (${Math.round(age / 1000)}s)`);
    process.exit(1);
  }

  process.exit(0);
} catch (err) {
  console.error('[healthcheck] no se encontró el archivo de heartbeat:', err.message);
  process.exit(1);
}
