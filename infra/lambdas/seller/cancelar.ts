import {
  callWallet,
  getSecretString,
  logEvent,
  WalletPermanentError
} from './shared';

export interface CancelarInput {
  idpk: string;
  cancelIdpk: string;
  cycleId: string;
  swapId: string;
  executionName?: string;
}

export interface CancelarResult {
  swapId: string;
  cancelled: boolean;
  status: number;
  reason?: string;
}

export interface CancelarDeps {
  getSecret?: (arn: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  walletBaseUrl?: string;
  walletApiKeyArn?: string;
}

export function createCancelarHandler(deps: CancelarDeps = {}) {
  return async function handler(rawInput: CancelarInput | { executionName?: string; state?: Record<string, any> }): Promise<CancelarResult> {
    const wrapped = (rawInput as { state?: Record<string, any>; executionName?: string }).state;
    const input: CancelarInput = wrapped
      ? {
          idpk: wrapped.reservation?.idpk ?? wrapped.idpk ?? '',
          cancelIdpk: wrapped.reservation?.cancelIdpk ?? wrapped.cancelIdpk ?? '',
          cycleId: wrapped.reservation?.cycleId ?? wrapped.cycleId ?? '',
          swapId: wrapped.reconciliation?.swapId ?? wrapped.proposal?.swapId ?? wrapped.swapId ?? '',
          executionName: (rawInput as { executionName?: string }).executionName
        }
      : (rawInput as CancelarInput);
    if (!input.swapId) {
      return { swapId: '', cancelled: false, status: 404, reason: 'MISSING_SWAP_ID' };
    }

    const getSecret = deps.getSecret ?? getSecretString;
    const walletBaseUrl = deps.walletBaseUrl ?? process.env.WALLET_BASE_URL ?? '';
    const walletApiKeyArn = deps.walletApiKeyArn ?? process.env.WALLET_API_KEY_ARN ?? '';
    const apiKey = await getSecret(walletApiKeyArn);

    try {
      const res = await callWallet({
        baseUrl: walletBaseUrl,
        apiKey,
        method: 'POST',
        path: `/swaps/${encodeURIComponent(input.swapId)}/cancel`,
        idpk: input.cancelIdpk,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
        now: deps.now
      });

      logEvent('cancelar_wallet_response', {
        cycleId: input.cycleId,
        idpk: input.idpk,
        swapId: input.swapId,
        cancelIdpk: input.cancelIdpk,
        status: res.status,
        executionName: input.executionName ?? null
      });

      return { swapId: input.swapId, cancelled: true, status: res.status };
    } catch (err) {
      // Si el swap ya venció, ya fue cancelado o no existe (404/409/422), continuamos a Compensar.
      if (err instanceof WalletPermanentError && [404, 409, 422].includes(err.status)) {
        logEvent('cancelar_already_closed', {
          cycleId: input.cycleId,
          idpk: input.idpk,
          swapId: input.swapId,
          status: err.status,
          reason: err.reason,
          executionName: input.executionName ?? null
        });
        return { swapId: input.swapId, cancelled: false, status: err.status, reason: err.reason };
      }
      throw err;
    }
  };
}

export const handler = createCancelarHandler();
