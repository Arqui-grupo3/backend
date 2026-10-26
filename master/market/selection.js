const Decimal = require('decimal.js').clone({ precision: 40 });
const METERS_PER_KM = 1000;

function rankOffers(
    offers,
    distanceTable,
    { cityId = 'REE', imbalancePrice}   
){
    const cap = new Decimal(imbalancePrice);
    if (!cap.isFinite() || cap.isNegative()){
        throw new Error('imbalancePrice invalido');
    }

    const candidates = [];

    for (const offer of offers){
        const remaining = offer.remaining ?? offer.quantity;
        const route = distanceTable?.distances?.[offer.cityId];

        if (offer.cityId === cityId || !(remaining > 0) || !route) continue;

        const rate = route.enabled?route.transportCost:distanceTable.disabledRouteTransportCost;

        if (rate == null) continue;

        // La central manda distance en metros y transportCost por km y kWh: transporte por
        // kWh = distance / 1000 × costo. Confirmado con un trade-recorded real (MET→REE:
        // distance 65880302 × 0.0001 / 1000 = 6.59 = transportPerEnergy de la central).
        const transport = new Decimal(route.distance).div(METERS_PER_KM).times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

        const effective = new Decimal(offer.pricePerEnergy).plus(transport);

        if (effective.gt(cap)) continue;
        candidates.push({
            effective,
            offer: {
                ...offer,
                transportPerEnergy: transport.toFixed(2),
                effectivePricePerEnergy: effective.toFixed(2),
                routeEnabled: route.enabled,
            },
        });
    }
    candidates.sort((a, b) =>
        a.effective.comparedTo(b.effective) ||
        a.offer.offerId.localeCompare(b.offer.offerId)
    );

    return candidates.map(({ offer }) => offer);
}

module.exports = { rankOffers };