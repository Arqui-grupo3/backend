import { randomUUID } from 'node:crypto';
import { logEvent, round2 } from './shared';

export interface SellerSagaInput {
  idpk: string;
  swapIdpk?: string;
  cancelIdpk?: string;
  cycleId: string;
  offerId: string;
  buyerCityId: string;
  bidMsgId: string;
  quantity: number;
  pricePerEnergy: number;
  expiresAt: string;
  closesAt?: string;
  startedAt?: string;
  executionName?: string;
}

export interface ReservarResult {
  valid: boolean;
  reason?: string;
  idpk: string;
  swapIdpk: string;
  cancelIdpk: string;
  cycleId: string;
  offerId: string;
  buyerCityId: string;
  bidMsgId: string;
  quantity: number;
  pricePerEnergy: number;
  amount: number;
  expiresAt: string;
  closesAt: string | null;
  startedAt: string;
  waitCloseSeconds: number;
}

const MIN_WAIT_SECONDS = 5;
const MAX_WAIT_SECONDS = 600;
const EXPIRES_MARGIN_SECONDS = 15;
const CLOSES_MARGIN_SECONDS = 30;

export function createReservarHandler({
  now = () => Date.now(),
  uuid = () => randomUUID()
}: { now?: () => number; uuid?: () => string } = {}) {
  return async function handler(input: Partial<SellerSagaInput>): Promise<ReservarResult> {
    const nowMs = now();
    const idpk = typeof input?.idpk === 'string' ? input.idpk.trim() : '';
    const swapIdpk = typeof input?.swapIdpk === 'string' && input.swapIdpk.trim() ? input.swapIdpk.trim() : uuid();
    const cancelIdpk = typeof input?.cancelIdpk === 'string' && input.cancelIdpk.trim() ? input.cancelIdpk.trim() : uuid();
    const cycleId = typeof input?.cycleId === 'string' ? input.cycleId.trim() : '';
    const offerId = typeof input?.offerId === 'string' ? input.offerId.trim() : '';
    const buyerCityId = typeof input?.buyerCityId === 'string' ? input.buyerCityId.trim() : '';
    const bidMsgId = typeof input?.bidMsgId === 'string' ? input.bidMsgId.trim() : '';
    const quantity = Number(input?.quantity);
    const pricePerEnergy = Number(input?.pricePerEnergy);
    const expiresAt = typeof input?.expiresAt === 'string' ? input.expiresAt : '';
    const closesAt = typeof input?.closesAt === 'string' && input.closesAt ? input.closesAt : null;
    const startedAt = typeof input?.startedAt === 'string' && input.startedAt ? input.startedAt : new Date(nowMs).toISOString();

    const base: ReservarResult = {
      valid: false,
      idpk,
      swapIdpk,
      cancelIdpk,
      cycleId,
      offerId,
      buyerCityId,
      bidMsgId,
      quantity: Number.isFinite(quantity) ? quantity : 0,
      pricePerEnergy: Number.isFinite(pricePerEnergy) ? round2(pricePerEnergy) : 0,
      amount: Number.isFinite(quantity) && Number.isFinite(pricePerEnergy) ? round2(quantity * pricePerEnergy) : 0,
      expiresAt,
      closesAt,
      startedAt,
      waitCloseSeconds: MIN_WAIT_SECONDS
    };

    if (!idpk || !cycleId || !offerId || !buyerCityId || !bidMsgId) {
      logEvent('reservar_invalid_input', { idpk, cycleId, offerId, reason: 'MISSING_REQUIRED_FIELDS' });
      return { ...base, reason: 'MISSING_REQUIRED_FIELDS' };
    }

    if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(pricePerEnergy) || pricePerEnergy <= 0) {
      logEvent('reservar_invalid_input', { idpk, cycleId, offerId, reason: 'INVALID_QUANTITY_OR_PRICE' });
      return { ...base, reason: 'INVALID_QUANTITY_OR_PRICE' };
    }

    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
      logEvent('reservar_expired', { idpk, cycleId, offerId, expiresAt, reason: 'SWAP_ALREADY_EXPIRED' });
      return { ...base, reason: 'SWAP_ALREADY_EXPIRED' };
    }

    let maxWaitSeconds = MAX_WAIT_SECONDS;
    if (closesAt) {
      const closesMs = Date.parse(closesAt);
      if (!Number.isFinite(closesMs) || closesMs <= nowMs) {
        logEvent('reservar_market_closed', { idpk, cycleId, offerId, closesAt, reason: 'MARKET_CLOSED' });
        return { ...base, reason: 'MARKET_CLOSED' };
      }
      maxWaitSeconds = Math.max(MIN_WAIT_SECONDS, Math.ceil((closesMs - nowMs) / 1000) + CLOSES_MARGIN_SECONDS);
    }

    const desiredWait = Math.ceil((expiresMs - nowMs) / 1000) + EXPIRES_MARGIN_SECONDS;
    const waitCloseSeconds = Math.min(Math.max(desiredWait, MIN_WAIT_SECONDS), Math.min(maxWaitSeconds, MAX_WAIT_SECONDS));

    logEvent('reservar_confirmed', {
      cycleId,
      idpk,
      swapIdpk,
      offerId,
      buyerCityId,
      quantity,
      amount: base.amount,
      waitCloseSeconds
    });

    return {
      ...base,
      valid: true,
      waitCloseSeconds
    };
  };
}

export const handler = createReservarHandler();
