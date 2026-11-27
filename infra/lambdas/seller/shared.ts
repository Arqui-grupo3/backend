import { createHmac } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export const RETRYABLE_HTTP_STATUS = new Set([500, 502, 503, 504]);
export const PERMANENT_HTTP_STATUS = new Set([401, 404, 422]);
export const MAX_RETRY_AFTER_SLEEP_MS = 10_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export class WalletRetryableError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, { status = 0, body = null }: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = 'WalletRetryableError';
    this.status = status;
    this.body = body;
  }
}

export class WalletPermanentError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly body: unknown;

  constructor(
    message: string,
    { status = 422, reason = 'WALLET_PERMANENT_ERROR', body = null }: { status?: number; reason?: string; body?: unknown } = {}
  ) {
    super(message);
    this.name = 'WalletPermanentError';
    this.status = status;
    this.reason = reason;
    this.body = body;
  }
}

export interface TaskTokenRecord {
  key: string;
  keyType: 'idpk' | 'swapId';
  taskToken: string;
  state: 'Proponer' | 'EsperarCierre';
  idpk: string;
  cycleId: string;
  swapId?: string | null;
  executionName?: string;
}

export interface TaskTokenSaveResult {
  alreadyResolved?: boolean;
  result?: Record<string, unknown>;
}

/**
 * Puerto de persistencia de task tokens.
 * En la iteración 1.1 usa noopTaskTokenStore; en la iteración 1.2 se conecta DynamoDB.
 */
export interface TaskTokenStore {
  saveBeforeCall(record: TaskTokenRecord): Promise<TaskTokenSaveResult>;
}

export const noopTaskTokenStore: TaskTokenStore = {
  async saveBeforeCall(record: TaskTokenRecord): Promise<TaskTokenSaveResult> {
    logEvent('task_token_hook_noop', {
      cycleId: record.cycleId,
      idpk: record.idpk,
      swapId: record.swapId ?? null,
      executionName: record.executionName ?? null,
      state: record.state,
      key: record.key,
      keyType: record.keyType
    });
    return { alreadyResolved: false };
  }
};

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    level: 'info',
    component: 'seller-saga',
    event,
    timestamp: new Date().toISOString(),
    ...fields
  }));
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  nowMs: number,
  fallbackMs = 1_000,
  maxMs = MAX_RETRY_AFTER_SLEEP_MS
): number {
  if (headerValue == null || headerValue === '') return Math.min(fallbackMs, maxMs);
  const seconds = Number(headerValue);
  let ms: number;
  if (Number.isFinite(seconds)) {
    ms = seconds * 1_000;
  } else {
    const parsedDate = Date.parse(headerValue);
    ms = Number.isFinite(parsedDate) ? parsedDate - nowMs : fallbackMs;
  }
  return Math.min(Math.max(Math.round(ms), 0), maxMs);
}

const secretCache = new Map<string, string>();
let defaultSecretsClient: SecretsManagerClient | null = null;

export function clearSecretCache(): void {
  secretCache.clear();
}

export async function getSecretString(
  secretArn: string,
  client?: { send: (cmd: GetSecretValueCommand) => Promise<{ SecretString?: string }> }
): Promise<string> {
  if (!secretArn) throw new Error('Falta ARN del secreto en Secrets Manager');
  const cached = secretCache.get(secretArn);
  if (cached !== undefined) return cached;

  const sm = client ?? (defaultSecretsClient ??= new SecretsManagerClient({}));
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!res.SecretString) {
    throw new Error(`El secreto ${secretArn} no contiene SecretString`);
  }
  secretCache.set(secretArn, res.SecretString);
  return res.SecretString;
}

export interface WalletCallOptions {
  baseUrl: string;
  apiKey: string;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  idpk?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface WalletCallResult {
  outcome: 'accepted' | 'immediate';
  status: number;
  body: Record<string, unknown> | null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function callWallet({
  baseUrl,
  apiKey,
  method,
  path,
  body,
  idpk,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  now = () => Date.now()
}: WalletCallOptions): Promise<WalletCallResult> {
  if (!baseUrl) throw new WalletPermanentError('Falta WALLET_BASE_URL', { status: 422, reason: 'MISSING_WALLET_BASE_URL' });
  if (!apiKey) throw new WalletPermanentError('Falta API key de la wallet', { status: 401, reason: 'MISSING_WALLET_API_KEY' });

  const root = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'X-Api-Key': apiKey,
    Accept: 'application/json'
  };
  if (idpk) headers['Idempotency-Key'] = idpk;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetchImpl(`${root}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const error = err as Error & { code?: string };
    const code = error?.name === 'TimeoutError' ? 'TIMEOUT' : (error?.code || error?.message || 'NETWORK_ERROR');
    throw new WalletRetryableError(`Error de red/timeout llamando a wallet ${method} ${path}: ${code}`, { status: 0 });
  }

  const rawText = await response.text();
  let parsed: Record<string, unknown> | null = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      parsed = { raw: rawText };
    }
  }

  if (response.status === 202) {
    return { outcome: 'accepted', status: 202, body: parsed };
  }

  if (response.status === 200 || response.status === 201) {
    return { outcome: 'immediate', status: response.status, body: parsed };
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers?.get?.('retry-after') ?? null;
    const waitMs = parseRetryAfterMs(retryAfterHeader, now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    throw new WalletRetryableError(`Wallet 429 Too Many Requests (esperado ${waitMs}ms)`, {
      status: 429,
      body: parsed
    });
  }

  if (RETRYABLE_HTTP_STATUS.has(response.status)) {
    throw new WalletRetryableError(`Wallet respondió HTTP ${response.status} en ${method} ${path}`, {
      status: response.status,
      body: parsed
    });
  }

  if (PERMANENT_HTTP_STATUS.has(response.status)) {
    const reason = String(parsed?.reason || parsed?.code || parsed?.error || `HTTP_${response.status}`);
    throw new WalletPermanentError(`Wallet rechazo definitivo HTTP ${response.status}: ${reason}`, {
      status: response.status,
      reason,
      body: parsed
    });
  }

  // Otros 4xx (ej. 400, 409) se consideran no reintentables en la wallet
  const reason = String(parsed?.reason || parsed?.code || parsed?.error || `HTTP_${response.status}`);
  throw new WalletPermanentError(`Wallet respondió HTTP ${response.status}: ${reason}`, {
    status: response.status,
    reason,
    body: parsed
  });
}

export function signSagaResult(secret: string, timestampSec: number, idpk: string, rawBody: string): string {
  return createHmac('sha256', secret)
    .update(`${timestampSec}.${idpk}.${rawBody}`)
    .digest('hex');
}
