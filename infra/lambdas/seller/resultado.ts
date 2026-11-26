import {
  DEFAULT_HTTP_TIMEOUT_MS,
  getSecretString,
  logEvent,
  signSagaResult,
  WalletPermanentError,
  WalletRetryableError
} from './shared';

export interface ResultadoInput {
  idpk: string;
  swapIdpk?: string | null;
  swapId?: string | null;
  cycleId: string;
  offerId?: string | null;
  outcome: 'settled' | 'compensated';
  reason?: string | null;
  proposalRejected?: boolean;
  startedAt?: string | null;
  closesAt?: string | null;
  executionName?: string | null;
}

export interface ResultadoDeps {
  getSecret?: (arn: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  masterBaseUrl?: string;
  internalHmacSecretArn?: string;
}

export function createResultadoHandler(deps: ResultadoDeps = {}) {
  return async function handler(
    rawInput: ResultadoInput | { outcome: 'settled' | 'compensated'; executionName?: string; state?: Record<string, any> }
  ): Promise<{ ok: boolean; outcome: string; masterStatus: number }> {
    const wrapped = (rawInput as { state?: Record<string, any>; outcome: 'settled' | 'compensated'; executionName?: string }).state;
    const input: ResultadoInput = wrapped
      ? {
          idpk: wrapped.reservation?.idpk ?? wrapped.idpk ?? '',
          swapIdpk: wrapped.reservation?.swapIdpk ?? wrapped.swapIdpk ?? null,
          swapId: wrapped.reconciliation?.swapId ?? wrapped.proposal?.swapId ?? wrapped.swapId ?? null,
          cycleId: wrapped.reservation?.cycleId ?? wrapped.cycleId ?? '',
          offerId: wrapped.reservation?.offerId ?? wrapped.offerId ?? null,
          outcome: (rawInput as { outcome: 'settled' | 'compensated' }).outcome,
          reason: wrapped.error?.Error
            ?? wrapped.closure?.eventType
            ?? wrapped.proposal?.eventType
            ?? wrapped.reconciliation?.status
            ?? wrapped.reservation?.reason
            ?? null,
          proposalRejected: !wrapped.notice?.published && (rawInput as { outcome: string }).outcome === 'compensated',
          startedAt: wrapped.reservation?.startedAt ?? wrapped.startedAt ?? null,
          closesAt: wrapped.reservation?.closesAt ?? wrapped.closesAt ?? null,
          executionName: (rawInput as { executionName?: string }).executionName ?? null
        }
      : (rawInput as ResultadoInput);
    const getSecret = deps.getSecret ?? getSecretString;
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const now = deps.now ?? (() => Date.now());
    const masterBaseUrl = (deps.masterBaseUrl ?? process.env.MASTER_BASE_URL ?? '').replace(/\/+$/, '');
    const secretArn = deps.internalHmacSecretArn ?? process.env.INTERNAL_HMAC_SECRET_ARN ?? '';

    if (!masterBaseUrl) {
      throw new WalletPermanentError('Falta MASTER_BASE_URL', { status: 422, reason: 'MISSING_MASTER_BASE_URL' });
    }

    const secret = await getSecret(secretArn);
    const timestampSec = Math.floor(now() / 1000);
    const payload = {
      role: 'seller',
      outcome: input.outcome,
      reason: input.reason ?? null,
      proposalRejected: Boolean(input.proposalRejected),
      swapId: input.swapId ?? null,
      swapIdpk: input.swapIdpk ?? null,
      cycleId: input.cycleId ?? null,
      offerId: input.offerId ?? null,
      startedAt: input.startedAt ?? null,
      closesAt: input.closesAt ?? null,
      executionName: input.executionName ?? null
    };
    const rawBody = JSON.stringify(payload);
    const signature = signSagaResult(secret, timestampSec, input.idpk, rawBody);

    let response: Response;
    try {
      response = await fetchImpl(`${masterBaseUrl}/internal/sagas/${encodeURIComponent(input.idpk)}/resultado`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Saga-Timestamp': String(timestampSec),
          'X-Saga-Signature': signature
        },
        body: rawBody,
        signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS)
      });
    } catch (err) {
      const error = err as Error;
      throw new WalletRetryableError(`Error de red/timeout notificando resultado a master: ${error.message}`, { status: 0 });
    }

    if (response.status >= 500 || response.status === 429) {
      throw new WalletRetryableError(`master respondió HTTP ${response.status} en /internal/sagas/resultado`, {
        status: response.status
      });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new WalletPermanentError(`master rechazó resultado con HTTP ${response.status}: ${text}`, {
        status: response.status,
        reason: `MASTER_HTTP_${response.status}`
      });
    }

    logEvent('resultado_notificado', {
      cycleId: input.cycleId,
      idpk: input.idpk,
      swapId: input.swapId ?? null,
      outcome: input.outcome,
      reason: input.reason ?? null,
      executionName: input.executionName ?? null
    });

    return { ok: true, outcome: input.outcome, masterStatus: response.status };
  };
}

export const handler = createResultadoHandler();
