import {
  callWallet,
  getSecretString,
  logEvent,
  round2,
  WalletPermanentError
} from './shared';

export interface ReconciliarInput {
  idpk: string;
  swapIdpk: string;
  cycleId: string;
  offerId: string;
  quantity: number;
  pricePerEnergy: number;
  expiresAt: string;
  swapId?: string | null;
  executionName?: string;
}

export interface ReconciliarResult {
  swapId: string | null;
  status: 'settled' | 'proposed' | 'expired' | 'cancelled' | 'rejected' | 'not_found';
  rawStatus: string | null;
}

export interface ReconciliarDeps {
  getSecret?: (arn: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  walletBaseUrl?: string;
  walletApiKeyArn?: string;
}

function normalizeSwapStatus(raw: unknown): ReconciliarResult['status'] {
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (s === 'settled') return 'settled';
  if (s === 'proposed' || s === 'pending') return 'proposed';
  if (s === 'expired') return 'expired';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'rejected') return 'rejected';
  return 'not_found';
}

export function createReconciliarHandler(deps: ReconciliarDeps = {}) {
  return async function handler(rawInput: ReconciliarInput | { executionName?: string; state?: Record<string, any> }): Promise<ReconciliarResult> {
    const wrapped = (rawInput as { state?: Record<string, any>; executionName?: string }).state;
    const input: ReconciliarInput = wrapped
      ? {
          idpk: wrapped.reservation?.idpk ?? wrapped.idpk ?? '',
          swapIdpk: wrapped.reservation?.swapIdpk ?? wrapped.swapIdpk ?? '',
          cycleId: wrapped.reservation?.cycleId ?? wrapped.cycleId ?? '',
          offerId: wrapped.reservation?.offerId ?? wrapped.offerId ?? '',
          quantity: wrapped.reservation?.quantity ?? wrapped.quantity ?? 0,
          pricePerEnergy: wrapped.reservation?.pricePerEnergy ?? wrapped.pricePerEnergy ?? 0,
          expiresAt: wrapped.reservation?.expiresAt ?? wrapped.expiresAt ?? '',
          swapId: wrapped.proposal?.swapId ?? wrapped.swapId ?? null,
          executionName: (rawInput as { executionName?: string }).executionName
        }
      : (rawInput as ReconciliarInput);
    const getSecret = deps.getSecret ?? getSecretString;
    const walletBaseUrl = deps.walletBaseUrl ?? process.env.WALLET_BASE_URL ?? '';
    const walletApiKeyArn = deps.walletApiKeyArn ?? process.env.WALLET_API_KEY_ARN ?? '';
    const apiKey = await getSecret(walletApiKeyArn);

    if (input.swapId) {
      try {
        const res = await callWallet({
          baseUrl: walletBaseUrl,
          apiKey,
          method: 'GET',
          path: `/swaps/${encodeURIComponent(input.swapId)}`,
          fetchImpl: deps.fetchImpl,
          sleep: deps.sleep,
          now: deps.now
        });
        const rawStatus = typeof res.body?.status === 'string' ? res.body.status : null;
        const status = normalizeSwapStatus(rawStatus);
        logEvent('reconciliar_by_swap_id', {
          cycleId: input.cycleId,
          idpk: input.idpk,
          swapId: input.swapId,
          status,
          rawStatus,
          executionName: input.executionName ?? null
        });
        return { swapId: input.swapId, status, rawStatus };
      } catch (err) {
        if (err instanceof WalletPermanentError && err.status === 404) {
          logEvent('reconciliar_not_found', {
            cycleId: input.cycleId,
            idpk: input.idpk,
            swapId: input.swapId,
            executionName: input.executionName ?? null
          });
          return { swapId: input.swapId, status: 'not_found', rawStatus: null };
        }
        throw err;
      }
    }

    // Si Proponer expiró antes de devolver swapId, reenviamos POST /swaps con la misma Idempotency-Key:
    // si la wallet sí lo procesó, responde 200 con swapId y status actual.
    try {
      const res = await callWallet({
        baseUrl: walletBaseUrl,
        apiKey,
        method: 'POST',
        path: '/swaps',
        idpk: input.swapIdpk,
        body: {
          give: { asset: 'KWH', amount: input.quantity },
          take: { asset: 'CR', amount: round2(input.quantity * input.pricePerEnergy) },
          expiresAt: input.expiresAt,
          memo: input.offerId
        },
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
        now: deps.now
      });
      const swapId = typeof res.body?.swapId === 'string'
        ? res.body.swapId
        : (typeof res.body?.id === 'string' ? res.body.id : null);
      const rawStatus = typeof res.body?.status === 'string' ? res.body.status : null;
      const status = swapId ? normalizeSwapStatus(rawStatus || 'proposed') : 'not_found';
      logEvent('reconciliar_by_idpk', {
        cycleId: input.cycleId,
        idpk: input.idpk,
        swapIdpk: input.swapIdpk,
        swapId,
        status,
        rawStatus,
        executionName: input.executionName ?? null
      });
      return { swapId, status, rawStatus };
    } catch (err) {
      if (err instanceof WalletPermanentError) {
        logEvent('reconciliar_permanent_error', {
          cycleId: input.cycleId,
          idpk: input.idpk,
          swapIdpk: input.swapIdpk,
          status: err.status,
          reason: err.reason,
          executionName: input.executionName ?? null
        });
        return { swapId: null, status: 'rejected', rawStatus: err.reason };
      }
      throw err;
    }
  };
}

export const handler = createReconciliarHandler();
