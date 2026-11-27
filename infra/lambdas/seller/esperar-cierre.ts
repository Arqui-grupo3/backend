import { SendTaskSuccessCommand, SFNClient } from '@aws-sdk/client-sfn';
import { logEvent, TaskTokenStore } from './shared';
import { resolveDefaultTokenStore } from './token-store';

export interface EsperarCierreEvent {
  taskToken: string;
  executionName?: string;
  input: {
    idpk: string;
    cycleId: string;
    swapId: string;
    expiresAt?: string;
  };
}

export interface EsperarCierreDeps {
  tokenStore?: TaskTokenStore;
  sfnClient?: { send: (cmd: SendTaskSuccessCommand) => Promise<unknown> };
}

let defaultSfnClient: SFNClient | null = null;

export function createEsperarCierreHandler(deps: EsperarCierreDeps = {}) {
  return async function handler(event: EsperarCierreEvent): Promise<{ waiting: boolean; immediate?: boolean }> {
    const { taskToken, executionName, input } = event;
    const tokenStore = deps.tokenStore ?? resolveDefaultTokenStore();
    const sfn = deps.sfnClient ?? (defaultSfnClient ??= new SFNClient({}));

    // ADR 0007: registrar el task token bajo swapId para swap-settled / swap-expired / swap-cancelled
    const saved = await tokenStore.saveBeforeCall({
      key: input.swapId,
      keyType: 'swapId',
      taskToken,
      state: 'EsperarCierre',
      idpk: input.idpk,
      cycleId: input.cycleId,
      swapId: input.swapId,
      executionName
    });

    if (saved.alreadyResolved && saved.result) {
      logEvent('esperar_cierre_already_resolved', {
        cycleId: input.cycleId,
        idpk: input.idpk,
        swapId: input.swapId,
        executionName: executionName ?? null
      });
      await sfn.send(new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify(saved.result)
      }));
      return { waiting: false, immediate: true };
    }

    logEvent('esperar_cierre_waiting', {
      cycleId: input.cycleId,
      idpk: input.idpk,
      swapId: input.swapId,
      executionName: executionName ?? null
    });

    return { waiting: true };
  };
}

export const handler = createEsperarCierreHandler();
