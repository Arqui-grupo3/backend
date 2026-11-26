import { SendTaskSuccessCommand, SFNClient } from '@aws-sdk/client-sfn';
import {
  callWallet,
  getSecretString,
  logEvent,
  round2,
  TaskTokenStore
} from './shared';
import { resolveDefaultTokenStore } from './token-store';
import type { ReservarResult } from './reservar';

export interface ProponerEvent {
  taskToken: string;
  executionName?: string;
  input: ReservarResult;
}

export interface ProponerDeps {
  tokenStore?: TaskTokenStore;
  getSecret?: (arn: string) => Promise<string>;
  sfnClient?: { send: (cmd: SendTaskSuccessCommand) => Promise<unknown> };
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  walletBaseUrl?: string;
  walletApiKeyArn?: string;
}

let defaultSfnClient: SFNClient | null = null;

function mapImmediateStatus(status: unknown): string {
  const s = typeof status === 'string' ? status.toLowerCase() : '';
  if (s === 'settled') return 'swap-settled';
  if (s === 'expired') return 'swap-expired';
  if (s === 'cancelled') return 'swap-cancelled';
  if (s === 'rejected') return 'swap-rejected';
  return 'swap-proposed';
}

export function createProponerHandler(deps: ProponerDeps = {}) {
  return async function handler(event: ProponerEvent): Promise<{ waiting: boolean; immediate?: boolean }> {
    const { taskToken, executionName, input } = event;
    const tokenStore = deps.tokenStore ?? resolveDefaultTokenStore();
    const getSecret = deps.getSecret ?? getSecretString;
    const walletBaseUrl = deps.walletBaseUrl ?? process.env.WALLET_BASE_URL ?? '';
    const walletApiKeyArn = deps.walletApiKeyArn ?? process.env.WALLET_API_KEY_ARN ?? '';
    const sfn = deps.sfnClient ?? (defaultSfnClient ??= new SFNClient({}));

    // ADR 0007: guardar el task token ANTES de llamar a la wallet
    const saved = await tokenStore.saveBeforeCall({
      key: input.swapIdpk,
      keyType: 'idpk',
      taskToken,
      state: 'Proponer',
      idpk: input.idpk,
      cycleId: input.cycleId,
      executionName
    });

    if (saved.alreadyResolved && saved.result) {
      logEvent('proponer_already_resolved', {
        cycleId: input.cycleId,
        idpk: input.idpk,
        swapId: saved.result.swapId ?? null,
        executionName: executionName ?? null
      });
      await sfn.send(new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify(saved.result)
      }));
      return { waiting: false, immediate: true };
    }

    const apiKey = await getSecret(walletApiKeyArn);
    const body = {
      give: { asset: 'KWH', amount: input.quantity },
      take: { asset: 'CR', amount: round2(input.quantity * input.pricePerEnergy) },
      expiresAt: input.expiresAt,
      memo: input.offerId
    };

    const res = await callWallet({
      baseUrl: walletBaseUrl,
      apiKey,
      method: 'POST',
      path: '/swaps',
      body,
      idpk: input.swapIdpk,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      now: deps.now
    });

    logEvent('proponer_wallet_response', {
      cycleId: input.cycleId,
      idpk: input.idpk,
      swapIdpk: input.swapIdpk,
      status: res.status,
      outcome: res.outcome,
      executionName: executionName ?? null
    });

    // HTTP 200: la wallet ya conocía esta Idempotency-Key y devuelve el estado del swap
    if (res.outcome === 'immediate') {
      const payload = res.body || {};
      const resolved = {
        eventType: mapImmediateStatus(payload.status),
        swapId: (payload.swapId ?? payload.id ?? null) as string | null,
        token: (payload.token ?? payload.swapToken ?? null) as string | null,
        expiresAt: (payload.expiresAt ?? input.expiresAt) as string,
        status: (payload.status ?? 'proposed') as string
      };
      await sfn.send(new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify(resolved)
      }));
      return { waiting: false, immediate: true };
    }

    // HTTP 202: esperar callback (swap-proposed / swap-rejected) o timeout de 30s
    return { waiting: true };
  };
}

export const handler = createProponerHandler();
