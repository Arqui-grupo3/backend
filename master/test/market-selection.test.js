const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rankOffers } = require('../market/selection');

const offer = (cityId, price, remaining = 100) => ({
  offerId: `${cityId}-1`,
  cityId,
  remaining,
  pricePerEnergy: price,
});

const offers = [
  offer('HGW', '300.00'),
  offer('MET', '330.00'),
];

const table = {
  disabledRouteTransportCost: 6,
  distances: {
    HGW: { distance: 100, transportCost: 1, enabled: true },
    MET: { distance: 100, transportCost: 0.2, enabled: true },
  },
};

const options = { imbalancePrice: '735.00' };

test('ordena por precio efectivo, incluyendo transporte', () => {
  const result = rankOffers(offers, table, options);

  assert.deepEqual(
    result.map(o => [o.cityId, o.effectivePricePerEnergy]),
    [['MET', '350.00'], ['HGW', '400.00']]
  );
});

test('aplica tarifa punitiva multiplicada por distancia', () => {
  const disabledTable = {
    ...table,
    distances: {
      ...table.distances,
      HGW: { distance: 50, transportCost: 1, enabled: false },
    },
  };

  const result = rankOffers(offers, disabledTable, options);
  const hgw = result.find(o => o.cityId === 'HGW');

  assert.equal(hgw.transportPerEnergy, '300.00');
  assert.equal(hgw.effectivePricePerEnergy, '600.00');
  assert.equal(hgw.routeEnabled, false);
});

test('permite igualar el tope, pero nunca superarlo', () => {
  const result = rankOffers(offers, table, {
    imbalancePrice: '350.00',
  });

  assert.deepEqual(result.map(o => o.cityId), ['MET']);
  assert.deepEqual(
    rankOffers(offers, table, { imbalancePrice: '349.99' }),
    []
  );
});

test('excluye ofertas propias, agotadas o sin ruta conocida', () => {
  const result = rankOffers([
    offer('REE', '1.00'),
    offer('HGW', '1.00', 0),
    offer('COR', '1.00'),
    offer('MET', '330.00'),
  ], table, options);

  assert.deepEqual(result.map(o => o.cityId), ['MET']);
});

test('redondea correctamente el transporte a dos decimales', () => {
  const result = rankOffers([offer('HGW', '1.00')], {
    distances: {
      HGW: { distance: 100.5, transportCost: 0.01, enabled: true },
    },
  }, options);

  assert.equal(result[0].transportPerEnergy, '1.01');
  assert.equal(result[0].effectivePricePerEnergy, '2.01');
});
