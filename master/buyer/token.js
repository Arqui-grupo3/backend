const { createPublicKey, verify } = require('node:crypto');
const Decimal = require('decimal.js').clone({ precision: 40 });

class InvalidSwapToken extends Error {}
const invalid = (message) => { throw new InvalidSwapToken(message); };
const money = (value) => {
  try {
    const n = new Decimal(value);
    if (!n.isFinite() || n.isNegative()) invalid('Monto inválido');
    return n;
  } catch { invalid('Monto inválido'); }
};

function createTokenVerifier({ walletBaseUrl, fetchImpl = globalThis.fetch, now = Date.now }) {
  // No se usa una URL entregada por el vendedor ni por el JWT.
  const jwksUrl = new URL('/.well-known/jwks.json', walletBaseUrl).href;
  let keys = [];
  let refreshedAt = -Infinity;

  return async function verifySwapToken(token, bid, data) {
    let header, claims, parts;
    try {
      if (typeof token !== 'string' || token.length > 20000) invalid('Token inválido');
      parts = token.split('.');
      if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) invalid('JWT inválido');
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { invalid('JWT inválido'); }
    if (!header || !claims || typeof header !== 'object' || typeof claims !== 'object') invalid('JWT inválido');
    if (header.alg !== 'ES256' || typeof header.kid !== 'string' || header.crit || header.b64 === false) {
      invalid('Cabecera JWT no permitida');
    }

    let jwk = keys.find(k => k.kid === header.kid);
    if (now() - refreshedAt >= 300000 || (!jwk && now() - refreshedAt >= 5000)) {
      const response = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`JWKS: HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.keys)) throw new Error('JWKS sin keys');
      keys = body.keys;
      refreshedAt = now();
      jwk = keys.find(k => k.kid === header.kid);
    }
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' ||
        (jwk.alg && jwk.alg !== 'ES256') || (jwk.use && jwk.use !== 'sig')) invalid('Llave JWT no válida');
    let signatureValid = false;
    try {
      signatureValid = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`),
        { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
        Buffer.from(parts[2], 'base64url'));
    } catch { invalid('Firma JWT inválida'); }
    if (!signatureValid) invalid('Firma JWT inválida');

    const amount = money(bid.price_per_energy).times(bid.quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (claims.iss !== 'wallet.energyshark' || claims.sub !== data.swapId ||
        claims.proposer !== bid.seller_city_id || claims.memo !== bid.offer_id ||
        claims.give?.asset !== 'KWH' || claims.give.amount !== bid.quantity ||
        claims.take?.asset !== 'CR' || !money(claims.take.amount).eq(amount) ||
        !Number.isFinite(claims.exp) || claims.exp * 1000 <= now() ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > now())) ||
        data.quantity !== bid.quantity || !money(data.pricePerEnergy).eq(bid.price_per_energy) ||
        !money(data.amount).eq(amount) || !Number.isFinite(Date.parse(data.expiresAt))) {
      invalid('El swap no corresponde al bid o está vencido');
    }
    const deadline = Math.min(claims.exp * 1000, Date.parse(data.expiresAt), +new Date(bid.closes_at));
    if (deadline <= now()) invalid('El swap está vencido');
    return new Date(deadline);
  };
}

module.exports = { createTokenVerifier, InvalidSwapToken };
