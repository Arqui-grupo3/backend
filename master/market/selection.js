const Decimal = require('decimal.js').clone({ precision: 40 });
const METERS_PER_KM = 1000;

function calculateTransportPerEnergy(distanceTable, cityId) {
  const route = distanceTable?.distances?.[cityId];
  if (!route || route.distance == null) return null;

  const rate = route.enabled
    ? route.transportCost
    : distanceTable.disabledRouteTransportCost;

  if (rate == null) return null;

  const distance = new Decimal(route.distance);
  const cost = new Decimal(rate);
  if (!distance.isFinite() || distance.isNegative() || !cost.isFinite() || cost.isNegative()) return null;

  return distance.div(METERS_PER_KM).times(cost)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

function rankOffers(offers, distanceTable, { cityId = 'REE', imbalancePrice }) {
  const cap = new Decimal(imbalancePrice);
  if (!cap.isFinite() || cap.isNegative()) {
    throw new Error('imbalancePrice invalido');
  }

  const candidates = [];

  for (const offer of offers) {
    const remaining = offer.remaining ?? offer.quantity;
    if (offer.cityId === cityId || !(remaining > 0)) continue;

    const transport = calculateTransportPerEnergy(distanceTable, offer.cityId);
    if (transport === null) continue;

    const effective = new Decimal(offer.pricePerEnergy).plus(transport);
    if (effective.gt(cap)) continue;

    candidates.push({
      effective,
      offer: {
        ...offer,
        transportPerEnergy: transport.toFixed(2),
        effectivePricePerEnergy: effective.toFixed(2),
        routeEnabled: distanceTable.distances[offer.cityId].enabled,
      },
    });
  }

  candidates.sort((a, b) =>
    a.effective.comparedTo(b.effective) ||
    a.offer.offerId.localeCompare(b.offer.offerId)
  );

  return candidates.map(({ offer }) => offer);
}

module.exports = { rankOffers, calculateTransportPerEnergy };
