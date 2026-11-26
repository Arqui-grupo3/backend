import { randomUUID } from 'node:crypto';
import * as amqp from 'amqplib';
import { getSecretString, logEvent, round2 } from './shared';

export interface AvisarInput {
  idpk: string;
  cycleId: string;
  offerId: string;
  buyerCityId: string;
  bidMsgId: string;
  quantity: number;
  pricePerEnergy: number;
  swapId: string;
  swapToken: string;
  expiresAt: string;
  executionName?: string;
}

export interface AmqpConfirmChannelLike {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Record<string, unknown>,
    callback: (err: unknown) => void
  ): boolean;
  close(): Promise<void>;
}

export interface AmqpConnectionLike {
  createConfirmChannel(): Promise<AmqpConfirmChannelLike>;
  close(): Promise<void>;
}

export interface AvisarDeps {
  getSecret?: (arn: string) => Promise<string>;
  connectAmqp?: (url: string) => Promise<AmqpConnectionLike>;
  brokerUrlArn?: string;
  ownCity?: string;
  uuid?: () => string;
  nowIso?: () => string;
}

const CITY_PATTERN = /^[A-Z]{3}$/;

export function createAvisarHandler(deps: AvisarDeps = {}) {
  return async function handler(input: AvisarInput): Promise<{ published: boolean; msgId: string; idpk: string; routingKey: string }> {
    const ownCity = deps.ownCity ?? process.env.CITY_ID ?? 'REE';
    const brokerUrlArn = deps.brokerUrlArn ?? process.env.BROKER_URL_ARN ?? '';
    const getSecret = deps.getSecret ?? getSecretString;
    const connectAmqp = deps.connectAmqp ?? ((url: string) => amqp.connect(url) as unknown as Promise<AmqpConnectionLike>);
    const uuid = deps.uuid ?? (() => randomUUID());
    const nowIso = deps.nowIso ?? (() => new Date().toISOString());

    if (!CITY_PATTERN.test(input.buyerCityId) || input.buyerCityId === ownCity) {
      throw new Error(`buyerCityId inválido para bid-accepted: ${input.buyerCityId}`);
    }
    if (!input.swapId || !input.swapToken || !input.bidMsgId) {
      throw new Error('Avisar requiere swapId, swapToken y bidMsgId');
    }

    const envelopeIdpk = uuid();
    let msgId = uuid();
    if (msgId.toLowerCase() === envelopeIdpk.toLowerCase()) msgId = uuid();

    const routingKey = `city.${input.buyerCityId}`;
    const envelope = {
      idpk: envelopeIdpk,
      msgId,
      type: 'bid-accepted',
      timestamp: nowIso(),
      cityId: ownCity,
      cycleId: input.cycleId,
      data: {
        target: input.bidMsgId,
        offerId: input.offerId,
        quantity: input.quantity,
        pricePerEnergy: round2(input.pricePerEnergy),
        amount: round2(input.quantity * input.pricePerEnergy),
        swapId: input.swapId,
        swapToken: input.swapToken,
        expiresAt: input.expiresAt
      }
    };

    const brokerUrl = await getSecret(brokerUrlArn);
    const connection = await connectAmqp(brokerUrl);
    let channel: AmqpConfirmChannelLike | null = null;

    try {
      channel = await connection.createConfirmChannel();
      await new Promise<void>((resolve, reject) => {
        channel!.publish(
          'energy.x',
          routingKey,
          Buffer.from(JSON.stringify(envelope)),
          {
            contentType: 'application/json',
            persistent: true,
            userId: `city.${ownCity}`
          },
          (err) => (err ? reject(err) : resolve())
        );
      });

      logEvent('avisar_published', {
        cycleId: input.cycleId,
        idpk: input.idpk,
        swapId: input.swapId,
        buyerCityId: input.buyerCityId,
        routingKey,
        msgId,
        executionName: input.executionName ?? null
      });

      return { published: true, msgId, idpk: envelopeIdpk, routingKey };
    } finally {
      if (channel) await channel.close().catch(() => {});
      await connection.close().catch(() => {});
    }
  };
}

export const handler = createAvisarHandler();
