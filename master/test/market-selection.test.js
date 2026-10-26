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
    HGW: { distance: 100000, transportCost: 1, enabled: true },
    MET: { distance: 100000, transportCost: 0.2, enabled: true },
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
      HGW: { distance: 50000, transportCost: 1, enabled: false },
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
      HGW: { distance: 100500, transportCost: 0.01, enabled: true },
    },
  }, options);

  assert.equal(result[0].transportPerEnergy, '1.01');
  assert.equal(result[0].effectivePricePerEnergy, '2.01');
});

// Datos reales de producción: distance-table de la central y trade-recorded de la venta
// REE→MET del ciclo 249226 (transportPerEnergy 6.59). La distancia viene en metros.
test('con la distance-table real, el transporte MET→REE es 6.59 y la oferta de MET se compra', () => {
  const real = {
    disabledRouteTransportCost: 0.05, // valor de ejemplo: no se usa (rutas habilitadas)
    distances: {
      MET: { enabled: true, distance: 65880302, transportCost: 0.0001 },
      KLD: { enabled: true, distance: 42193361, transportCost: 0.0175 },
    },
  };
  const result = rankOffers([
    { offerId: 'MET-249222', cityId: 'MET', quantity: 19175, remaining: 19175, pricePerEnergy: '49.52' },
    { offerId: 'KLD-249222', cityId: 'KLD', quantity: 1000, remaining: 1000, pricePerEnergy: '10.00' },
  ], real, { cityId: 'REE', imbalancePrice: 288.72 });

  assert.deepEqual(result.map(o => [o.offerId, o.transportPerEnergy, o.effectivePricePerEnergy]), [
    ['MET-249222', '6.59', '56.11'],
  ], 'KLD queda en 10 + 738.38 > 288.72 y se descarta');
});
