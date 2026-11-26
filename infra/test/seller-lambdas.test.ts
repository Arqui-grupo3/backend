import { createReservarHandler, ReservarResult } from '../lambdas/seller/reservar';
import { createProponerHandler } from '../lambdas/seller/proponer';
import { createEsperarCierreHandler } from '../lambdas/seller/esperar-cierre';
import { createAvisarHandler } from '../lambdas/seller/avisar';
import { createReconciliarHandler } from '../lambdas/seller/reconciliar';
import { createCancelarHandler } from '../lambdas/seller/cancelar';
import { createResultadoHandler } from '../lambdas/seller/resultado';
import { signSagaResult, WalletPermanentError, WalletRetryableError } from '../lambdas/seller/shared';

function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => lowerHeaders[k.toLowerCase()] ?? null } as Headers,
    text: async () => (body === undefined ? '' : JSON.stringify(body))
  } as unknown as Response;
}

const BASE_RESERVATION: ReservarResult = {
  valid: true,
  idpk: '11111111-1111-4111-8111-111111111111',
  swapIdpk: '22222222-2222-4222-8222-222222222222',
  cancelIdpk: '33333333-3333-4333-8333-333333333333',
  cycleId: 'cycle-2026-11-24T19:00:00Z',
  offerId: 'offer-ree-1',
  buyerCityId: 'HGW',
  bidMsgId: '44444444-4444-4444-8444-444444444444',
  quantity: 100,
  pricePerEnergy: 150.5,
  amount: 15050,
  expiresAt: '2026-11-24T19:01:00.000Z',
  closesAt: '2026-11-24T19:10:00.000Z',
  startedAt: '2026-11-24T19:00:00.000Z',
  waitCloseSeconds: 75
};

describe('Reservar handler', () => {
  test('valida entrada y calcula waitCloseSeconds = expiresAt + 15s acotado por closesAt + 30s', async () => {
    const now = () => Date.parse('2026-11-24T19:00:00.000Z');
    const handler = createReservarHandler({ now, uuid: () => '99999999-9999-4999-8999-999999999999' });

    const res = await handler({
      idpk: BASE_RESERVATION.idpk,
      cycleId: BASE_RESERVATION.cycleId,
      offerId: BASE_RESERVATION.offerId,
      buyerCityId: 'HGW',
      bidMsgId: BASE_RESERVATION.bidMsgId,
      quantity: 100,
      pricePerEnergy: 150.5,
      expiresAt: '2026-11-24T19:01:00.000Z',
      closesAt: '2026-11-24T19:01:10.000Z'
    });

    expect(res.valid).toBe(true);
    expect(res.amount).toBe(15050);
    // expiresAt + 15s = 75s, closesAt + 30s = 100s -> min = 75s
    expect(res.waitCloseSeconds).toBe(75);
  });

  test('rechaza input ya vencido sin lanzar excepcion', async () => {
    const now = () => Date.parse('2026-11-24T19:05:00.000Z');
    const handler = createReservarHandler({ now });
    const res = await handler({ ...BASE_RESERVATION, closesAt: undefined, expiresAt: '2026-11-24T19:01:00.000Z' });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('SWAP_ALREADY_EXPIRED');
  });
});

describe('Proponer handler (orden de taskToken y respuestas HTTP)', () => {
  test('guarda taskToken ANTES de llamar a POST /swaps y espera callback en HTTP 202', async () => {
    const order: string[] = [];
    let capturedHeaders: Record<string, string> = {};

    const handler = createProponerHandler({
      walletBaseUrl: 'https://wallet.test',
      walletApiKeyArn: 'arn:aws:secretsmanager:us-east-2:123:secret:wallet',
      getSecret: async () => 'secret-api-key',
      tokenStore: {
        saveBeforeCall: async (rec) => {
          order.push(`save:${rec.key}:${rec.state}`);
          return { alreadyResolved: false };
        }
      },
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        order.push('fetch:POST:/swaps');
        capturedHeaders = (init?.headers || {}) as Record<string, string>;
        return mockResponse(202, { accepted: true });
      }) as typeof fetch,
      sfnClient: { send: async () => { order.push('sfn:send'); } }
    });

    const result = await handler({ taskToken: 'tok-123', input: BASE_RESERVATION });
    expect(result).toEqual({ waiting: true });
    expect(order).toEqual([`save:${BASE_RESERVATION.swapIdpk}:Proponer`, 'fetch:POST:/swaps']);
    expect(capturedHeaders['Idempotency-Key']).toBe(BASE_RESERVATION.swapIdpk);
  });

  test('en HTTP 200 resuelve inmediatamente con SendTaskSuccess sin esperar evento', async () => {
    const sfnCalls: unknown[] = [];
    const handler = createProponerHandler({
      walletBaseUrl: 'https://wallet.test',
      walletApiKeyArn: 'arn:test',
      getSecret: async () => 'secret-api-key',
      fetchImpl: (async () => mockResponse(200, { swapId: 'sw-1', status: 'proposed', token: 'jwt-tok' })) as typeof fetch,
      sfnClient: { send: async (cmd) => { sfnCalls.push(cmd); } }
    });

    const result = await handler({ taskToken: 'tok-200', input: BASE_RESERVATION });
    expect(result).toEqual({ waiting: false, immediate: true });
    expect(sfnCalls).toHaveLength(1);
  });

  test('en HTTP 429 respeta Retry-After y lanza WalletRetryableError', async () => {
    const slept: number[] = [];
    const handler = createProponerHandler({
      walletBaseUrl: 'https://wallet.test',
      walletApiKeyArn: 'arn:test',
      getSecret: async () => 'secret-api-key',
      sleep: async (ms) => { slept.push(ms); },
      fetchImpl: (async () => mockResponse(429, { reason: 'RATE_LIMITED' }, { 'Retry-After': '3' })) as typeof fetch
    });

    await expect(handler({ taskToken: 'tok-429', input: BASE_RESERVATION })).rejects.toBeInstanceOf(WalletRetryableError);
    expect(slept).toEqual([3000]);
  });

  test('en HTTP 504 lanza WalletRetryableError para que Step Functions reintente', async () => {
    const handler = createProponerHandler({
      walletBaseUrl: 'https://wallet.test',
      walletApiKeyArn: 'arn:test',
      getSecret: async () => 'secret-api-key',
      fetchImpl: (async () => mockResponse(504, { error: 'gateway timeout' })) as typeof fetch
    });

    await expect(handler({ taskToken: 'tok-504', input: BASE_RESERVATION })).rejects.toBeInstanceOf(WalletRetryableError);
  });

  test('en HTTP 422 IDEMPOTENCY_MISMATCH lanza WalletPermanentError (sin reintento)', async () => {
    const handler = createProponerHandler({
      walletBaseUrl: 'https://wallet.test',
      walletApiKeyArn: 'arn:test',
      getSecret: async () => 'secret-api-key',
      fetchImpl: (async () => mockResponse(422, { reason: 'IDEMPOTENCY_MISMATCH' })) as typeof fetch
    });

    await expect(handler({ taskToken: 'tok-422', input: BASE_RESERVATION })).rejects.toBeInstanceOf(WalletPermanentError);
  });
});

describe('EsperarCierre, Avisar, Reconciliar, Cancelar y Resultado', () => {
  test('EsperarCierre invoca tokenStore.saveBeforeCall con keyType swapId', async () => {
    let savedKey = '';
    const handler = createEsperarCierreHandler({
      tokenStore: {
        saveBeforeCall: async (rec) => {
          savedKey = `${rec.keyType}:${rec.key}`;
          return { alreadyResolved: false };
        }
      }
    });
    const res = await handler({
      taskToken: 'tok-close',
      input: { idpk: BASE_RESERVATION.idpk, cycleId: BASE_RESERVATION.cycleId, swapId: 'sw-99' }
    });
    expect(res).toEqual({ waiting: true });
    expect(savedKey).toBe('swapId:sw-99');
  });

  test('Avisar publica bid-accepted confirmado en energy.x -> city.<buyer>', async () => {
    let published: { exchange: string; routingKey: string; body: any; opts: any } | null = null;
    const handler = createAvisarHandler({
      brokerUrlArn: 'arn:broker',
      ownCity: 'REE',
      getSecret: async () => 'amqps://user:pass@broker.test/vhost',
      connectAmqp: async () => ({
        createConfirmChannel: async () => ({
          publish: (exchange, routingKey, content, opts, cb) => {
            published = { exchange, routingKey, body: JSON.parse(content.toString('utf8')), opts };
            cb(null);
            return true;
          },
          close: async () => {}
        }),
        close: async () => {}
      })
    });

    const res = await handler({
      idpk: BASE_RESERVATION.idpk,
      cycleId: BASE_RESERVATION.cycleId,
      offerId: BASE_RESERVATION.offerId,
      buyerCityId: 'HGW',
      bidMsgId: BASE_RESERVATION.bidMsgId,
      quantity: 100,
      pricePerEnergy: 150.5,
      swapId: 'sw-99',
      swapToken: 'jwt-token',
      expiresAt: BASE_RESERVATION.expiresAt
    });

    expect(res.published).toBe(true);
    expect(published!.exchange).toBe('energy.x');
    expect(published!.routingKey).toBe('city.HGW');
    expect(published!.opts.userId).toBe('city.REE');
    expect(published!.body.type).toBe('bid-accepted');
    expect(published!.body.idpk).not.toBe(published!.body.msgId);
    expect(published!.body.data.swapToken).toBe('jwt-token');
  });

  test('Reconciliar consulta GET /swaps/{swapId} y devuelve settled', async () => {
    const handler = createReconciliarHandler({
      walletBaseUrl: 'https://wallet.test',
      walletApiKeyArn: 'arn:wallet',
      getSecret: async () => 'secret-key',
      fetchImpl: (async () => mockResponse(200, { swapId: 'sw-99', status: 'settled' })) as typeof fetch
    });
    const res = await handler({
      state: { reservation: BASE_RESERVATION, proposal: { swapId: 'sw-99' } }
    });
    expect(res).toEqual({ swapId: 'sw-99', status: 'settled', rawStatus: 'settled' });
  });

  test('Cancelar envia POST /swaps/{swapId}/cancel con cancelIdpk', async () => {
    let usedKey = '';
    const handler = createCancelarHandler({
      walletBaseUrl: 'https://wallet.test',
      walletApiKeyArn: 'arn:wallet',
      getSecret: async () => 'secret-key',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        usedKey = ((init?.headers || {}) as Record<string, string>)['Idempotency-Key'];
        return mockResponse(202, { status: 'cancelling' });
      }) as typeof fetch
    });
    const res = await handler({
      state: { reservation: BASE_RESERVATION, reconciliation: { swapId: 'sw-99' } }
    });
    expect(res.cancelled).toBe(true);
    expect(usedKey).toBe(BASE_RESERVATION.cancelIdpk);
  });

  test('Resultado firma el payload con HMAC-SHA256 valido hacia master', async () => {
    const fixedNowMs = 1_764_000_000_000;
    const secret = 'super-hmac-secret';
    let receivedHeaders: Record<string, string> = {};
    let receivedBody = '';

    const handler = createResultadoHandler({
      masterBaseUrl: 'https://www.fasantamaria.me',
      internalHmacSecretArn: 'arn:hmac',
      getSecret: async () => secret,
      now: () => fixedNowMs,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        receivedHeaders = (init?.headers || {}) as Record<string, string>;
        receivedBody = String(init?.body || '');
        return mockResponse(200, { ok: true });
      }) as typeof fetch
    });

    const res = await handler({
      outcome: 'compensated',
      executionName: BASE_RESERVATION.idpk,
      state: { reservation: BASE_RESERVATION, error: { Error: 'WalletPermanentError' } }
    });

    expect(res.ok).toBe(true);
    const expectedSig = signSagaResult(secret, Math.floor(fixedNowMs / 1000), BASE_RESERVATION.idpk, receivedBody);
    expect(receivedHeaders['X-Saga-Signature']).toBe(expectedSig);
    expect(receivedHeaders['X-Saga-Timestamp']).toBe(String(Math.floor(fixedNowMs / 1000)));
  });
});
