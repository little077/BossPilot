import { redact } from '@/lib/diagnostics/redaction';
import type { GenerationErrorCode } from '@/lib/domain/chat';

export type { GenerationErrorCode } from '@/lib/domain/chat';

const MAX_PUBLIC_ERROR_CHARS = 360;

export class GenerationError extends Error {
  constructor(
    readonly code: GenerationErrorCode,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}

export function sanitizeGenerationError(error: unknown, secret = ''): GenerationError {
  if (error instanceof GenerationError) {
    return new GenerationError(
      error.code,
      sanitizeMessage(error.message, secret),
      error.retryable,
      error.status,
    );
  }

  const status = readHttpStatus(error);
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = sanitizeMessage(rawMessage, secret);

  if (status === 401 || status === 403) {
    return new GenerationError('AUTH_ERROR', '模型厂商拒绝了凭据，请检查 API Key。', false, status);
  }
  if (status === 429) {
    return new GenerationError(
      'RATE_LIMITED',
      '请求过于频繁或额度不足，请稍后重试。',
      true,
      status,
    );
  }
  if (status === 408) {
    return new GenerationError('TIMEOUT', '模型响应超时，请稍后重试。', true, status);
  }
  if (status !== undefined && status >= 500) {
    return new GenerationError('UPSTREAM_ERROR', '模型厂商暂时不可用，请稍后重试。', true, status);
  }
  if (isTimeoutError(error)) {
    return new GenerationError('TIMEOUT', '模型响应超时，请稍后重试。', true);
  }

  return new GenerationError(
    'NETWORK_ERROR',
    message ? `模型请求失败：${message}` : '模型请求失败，请检查网络后重试。',
    true,
    status,
  );
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function sanitizeMessage(message: string, secret: string): string {
  const withoutExactSecret = secret ? message.split(secret).join('[REDACTED]') : message;
  return redact(withoutExactSecret).replace(/\s+/g, ' ').trim().slice(0, MAX_PUBLIC_ERROR_CHARS);
}

function readHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  for (const key of ['status', 'statusCode']) {
    const value = Reflect.get(error, key);
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  const message = error instanceof Error ? error.message : '';
  const labelled = message.match(/\b(?:HTTP|status(?: code)?)\D{0,8}(\d{3})\b/i);
  if (labelled) return Number(labelled[1]);
  const bare = message.match(/\b(401|403|408|429|5\d{2})\b/);
  return bare ? Number(bare[1]) : undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(error.message);
}
