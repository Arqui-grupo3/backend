// Contract tests (RDOC04): los mensajes reales de la central guardados en
// contracts/central-real.json tienen que pasar la validación del connector.
// Si la central cambia un campo o un formato, esta prueba falla antes del deploy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { validateEnvelope, validateMarketMessage } = require('../validation');

const fixtures = require(join(__dirname, '../../contracts/central-real.json'));
const entries = Object.entries(fixtures).filter(([name]) => !name.startsWith('_'));

test('hay mensajes reales para validar', () => {
  assert.ok(entries.length >= 4, 'contracts/central-real.json debe traer al menos 4 mensajes');
});

for (const [name, { cola, userId, routingKey, mensaje }] of entries) {
  test(`contrato: el connector acepta el ${name} real de la central`, () => {
    const result = cola === 'market'
      ? validateMarketMessage(mensaje, { routingKey })
      : validateEnvelope(mensaje, { userId });
    assert.equal(result, null, `${name} fue rechazado: ${JSON.stringify(result)}`);
  });
}
