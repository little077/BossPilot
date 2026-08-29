import { describe, expect, it } from 'vitest';
import { GenerationError, isAbortError, sanitizeGenerationError } from '@/lib/generation/errors';

function errorWithStatus(status: unknown, key: 'status' | 'statusCode' = 'status'): Error {
  return Object.assign(new Error('request failed'), { [key]: status });
}

describe('generation errors', () => {
  it('preserves a typed error while redacting and bounding its public message', () => {
    const secret = 'plain-private-value';
    const source = new GenerationError(
      'INVALID_RESPONSE',
      `apiKey=${secret} ${'x'.repeat(500)}`,
      true,
      422,
    );

    const result = sanitizeGenerationError(source, secret);

    expect(result).not.toBe(source);
    expect(result).toMatchObject({
      name: 'GenerationError',
      code: 'INVALID_RESPONSE',
      retryable: true,
      status: 422,
    });
    expect(result.message).not.toContain(secret);
    expect(result.message.length).toBeLessThanOrEqual(360);
  });

  it.each([
    [401, 'AUTH_ERROR', false],
    [403, 'AUTH_ERROR', false],
    [408, 'TIMEOUT', true],
    [429, 'RATE_LIMITED', true],
    [500, 'UPSTREAM_ERROR', true],
    [503, 'UPSTREAM_ERROR', true],
  ] as const)('maps HTTP %i to %s', (status, code, retryable) => {
    expect(sanitizeGenerationError(errorWithStatus(status))).toMatchObject({
      code,
      retryable,
      status,
    });
  });

  it('reads statusCode and labelled or bare HTTP status text', () => {
    expect(sanitizeGenerationError(errorWithStatus(429, 'statusCode')).code).toBe('RATE_LIMITED');
    expect(sanitizeGenerationError(new Error('HTTP status code: 503 upstream')).code).toBe(
      'UPSTREAM_ERROR',
    );
    expect(sanitizeGenerationError(new Error('provider returned 401')).code).toBe('AUTH_ERROR');
    expect(sanitizeGenerationError(errorWithStatus('401')).code).toBe('NETWORK_ERROR');
    expect(sanitizeGenerationError({ message: 'oops' }).code).toBe('NETWORK_ERROR');
  });

  it('recognizes timeout errors and safely handles unknown values', () => {
    const namedTimeout = new Error('slow provider');
    namedTimeout.name = 'TimeoutError';

    expect(sanitizeGenerationError(namedTimeout)).toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    });
    expect(sanitizeGenerationError(new Error('request timed out')).code).toBe('TIMEOUT');
    expect(sanitizeGenerationError(null)).toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
    });
    expect(sanitizeGenerationError('')).toMatchObject({
      code: 'NETWORK_ERROR',
      message: '模型请求失败，请检查网络后重试。',
    });
  });

  it('identifies only AbortError instances as cancellation', () => {
    const error = new Error('cancelled');
    error.name = 'AbortError';

    expect(isAbortError(error)).toBe(true);
    expect(isAbortError(new DOMException('cancelled', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('AbortError'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});
