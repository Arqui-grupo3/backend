const { test } = require('node:test');
const assert = require('node:assert/strict');
const log = require('../log');

function fakeConsole() {
  const lines = [];
  const target = {
    log: (m) => lines.push(['log', m]), info: (m) => lines.push(['info', m]),
    warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m])
  };
  return { lines, target };
}

function fakeAgent() {
  const events = [];
  return { events, agent: { recordLogEvent: (e) => events.push(e) } };
}

test('log: extrae los campos de correlación de un mensaje', () => {
  assert.deepEqual(log.fieldsFromMessage({
    idpk: 'bid-1', msgId: 'm-1', type: 'bid', cycleId: 'cycle-9', cityId: 'MET', data: { offerId: 'off-1', quantity: 5 }
  }), { cycleId: 'cycle-9', idpk: 'bid-1', msgId: 'm-1', type: 'bid', cityId: 'MET', offerId: 'off-1' });

  // En los eventos de la wallet, data.idpk es la llave de nuestra operación.
  assert.deepEqual(log.fieldsFromMessage({
    idpk: 'evt-1', type: 'swap-proposed', cycleId: 'cycle-9', data: { swapId: 'sw-1', idpk: 'op-1' }
  }), { cycleId: 'cycle-9', idpk: 'evt-1', type: 'swap-proposed', swapId: 'sw-1', swapIdpk: 'op-1' });

  // Resultado de una saga: campos en el primer nivel.
  assert.deepEqual(log.fieldsFromMessage({ cycleId: 'c', swapId: 's', swapIdpk: 'k', offerId: 'o', executionName: 'e', outcome: 'settled' }),
    { cycleId: 'c', swapId: 's', swapIdpk: 'k', offerId: 'o', executionName: 'e' });

  assert.deepEqual(log.fieldsFromMessage(null), {});
  assert.deepEqual(log.fieldsFromMessage({ idpk: 42, cycleId: '' }), {}, 'solo texto no vacío');
});

test('log: cada línea lleva el contexto del mensaje en curso, también después de un await', async () => {
  const { lines, target } = fakeConsole();
  const { events, agent } = fakeAgent();
  log.install({ component: 'test', target, agent });

  await log.run({ cycleId: 'cycle-1', idpk: 'bid-1' }, async () => {
    target.log('[seller] recibido');
    await new Promise((r) => setTimeout(r, 5));
    await log.run({ swapId: 'sw-1' }, async () => target.error('[seller] falló %s', 'propose'));
  });
  target.warn('[master] sin contexto');

  assert.deepEqual(lines, [
    ['log', '[seller] recibido | cycleId=cycle-1 idpk=bid-1'],
    ['error', '[seller] falló propose | cycleId=cycle-1 idpk=bid-1 swapId=sw-1'],
    ['warn', '[master] sin contexto']
  ]);
  assert.deepEqual(events[1], {
    message: '[seller] falló propose', level: 'ERROR', component: 'test', scope: 'seller',
    cycleId: 'cycle-1', idpk: 'bid-1', swapId: 'sw-1'
  });
  assert.equal(events[2].level, 'WARN');
  assert.equal(events[2].cycleId, undefined);
});

test('log: dos mensajes procesados en paralelo no mezclan su contexto', async () => {
  const { lines, target } = fakeConsole();
  log.install({ component: 'test', target, agent: null });
  const handle = (idpk, ms) => log.run({ idpk }, async () => {
    await new Promise((r) => setTimeout(r, ms));
    target.log('listo');
  });
  await Promise.all([handle('a', 10), handle('b', 1)]);
  assert.deepEqual(lines.map(([, m]) => m).sort(), ['listo | idpk=a', 'listo | idpk=b']);
});

test('log: el middleware toma el contexto del body y de la ruta de la saga', async () => {
  const seen = [];
  const next = () => seen.push(log.context());
  log.middleware({ path: '/events', body: { idpk: 'evt-2', cycleId: 'c-2', type: 'swap-settled', data: { swapId: 'sw-2' } } }, {}, next);
  log.middleware({ path: '/internal/sagas/bid-7/resultado', body: { cycleId: 'c-3', swapId: 'sw-3', outcome: 'settled' } }, {}, next);
  log.middleware({ path: '/cycles', body: undefined }, {}, next);
  assert.deepEqual(seen, [
    { cycleId: 'c-2', idpk: 'evt-2', type: 'swap-settled', swapId: 'sw-2' },
    { cycleId: 'c-3', swapId: 'sw-3', idpk: 'bid-7', executionName: 'bid-7' },
    {}
  ]);
});

test('log: un error al enviar a New Relic no interrumpe el log', () => {
  const { lines, target } = fakeConsole();
  log.install({ component: 'test', target, agent: { recordLogEvent: () => { throw new Error('caído'); } } });
  target.info('hola');
  assert.deepEqual(lines, [['info', 'hola']]);
});

test('log: una línea JSON sigue siendo JSON, con el contexto adentro', async () => {
  const { lines, target } = fakeConsole();
  const sent = [];
  log.install({ component: 'master', target, agent: { recordLogEvent: (e) => sent.push(e) } });
  await log.run({ cycleId: 'c-9', idpk: 'evt-9', swapId: 'sw-9', type: 'swap-settled' }, async () => {
    target.log(JSON.stringify({ level: 'info', component: 'master-saga-resumer', event: 'saga_resume_sent_success', idpk: 'op-9', swapId: 'sw-9' }));
  });
  const line = JSON.parse(lines[0][1]);
  // Los campos propios de la línea mandan; el contexto completa lo que falta.
  assert.equal(line.idpk, 'op-9');
  assert.equal(line.cycleId, 'c-9');
  assert.equal(line.type, 'swap-settled');
  assert.equal(line.component, 'master-saga-resumer');
  assert.equal(sent[0].event, 'saga_resume_sent_success');
  assert.equal(sent[0].level, 'INFO');
  assert.equal(sent[0].cycleId, 'c-9');
  assert.equal(sent[0].component, 'master-saga-resumer');
});
