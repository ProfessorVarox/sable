import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react';
import { createDebugLogger, getDebugLogger } from './debugLogger';

vi.mock('@sentry/react', () => ({
  addBreadcrumb: vi.fn<(...args: unknown[]) => void>(),
  captureException: vi.fn<(...args: unknown[]) => void>(),
  captureMessage: vi.fn<(...args: unknown[]) => void>(),
  getCurrentScope: () => ({
    setExtra: vi.fn<(...args: unknown[]) => void>(),
    addAttachment: vi.fn<(...args: unknown[]) => void>(),
  }),
  logger: {
    debug: vi.fn<(...args: unknown[]) => void>(),
    info: vi.fn<(...args: unknown[]) => void>(),
    warn: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>(),
  },
  metrics: { count: vi.fn<(...args: unknown[]) => void>() },
  setContext: vi.fn<(...args: unknown[]) => void>(),
}));

describe('DebugLoggerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const debugLogger = getDebugLogger();
    debugLogger.clear();
    debugLogger.setEnabled(false);
  });

  it('stores operational warnings for local export without sending them to Sentry when disabled', () => {
    createDebugLogger('test').warn('sync', 'normal event');

    const exported = JSON.parse(getDebugLogger().exportLogs()) as {
      logsCount: number;
      logs: { level: string; message: string }[];
    };

    expect(exported.logsCount).toBe(1);
    expect(exported.logs).toEqual([
      expect.objectContaining({ level: 'warn', message: 'normal event' }),
    ]);
    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
    expect(Sentry.logger.warn).not.toHaveBeenCalled();
  });
});

describe('debug logger diagnostic capture', () => {
  const logger = getDebugLogger();

  beforeEach(() => {
    logger.stopCapture();
    logger.setEnabled(false);
    logger.clear();
  });

  it('keeps the default buffer bounded to errors and operational warnings', () => {
    logger.log('info', 'general', 'test', 'verbose event');
    logger.log('warn', 'ui', 'test', 'low signal warning');
    logger.log('warn', 'sync', 'test', 'sync warning');
    logger.log('error', 'ui', 'test', 'error event');

    expect(logger.getLogs().map((entry) => entry.message)).toEqual(['sync warning', 'error event']);
  });

  it('clears old entries and captures verbose events only during an explicit session', () => {
    logger.log('error', 'error', 'test', 'before capture');
    const since = logger.startCapture();
    logger.log('info', 'general', 'test', 'during capture');
    logger.stopCapture();

    expect(logger.getFilteredLogs({ since })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'Diagnostic capture started' }),
        expect.objectContaining({ message: 'during capture' }),
        expect.objectContaining({ message: 'Diagnostic capture stopped' }),
      ])
    );
    expect(logger.getLogs().some((entry) => entry.message === 'before capture')).toBe(false);
  });

  it('sanitizes entries before storing them in memory', () => {
    logger.log('error', 'network', 'test', 'request https://matrix.example/@alice:example.org', {
      access_token: 'secret',
      data: 'private payload',
    });

    const stored = JSON.stringify(logger.getLogs());
    expect(stored).not.toContain('secret');
    expect(stored).not.toContain('matrix.example');
    expect(stored).not.toContain('private payload');
    expect(logger.getLogs()[0]?.data).toBeUndefined();
  });

  it.each([
    [
      'circular values',
      () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
    ],
    ['BigInts', () => 1n],
  ])('does not throw for %s', (_, createValue) => {
    expect(() => logger.log('error', 'error', 'test', 'unsafe value', createValue())).not.toThrow();
    expect(logger.getLogs()).toHaveLength(1);
  });

  it('preserves the original Error for Sentry exception capture', async () => {
    const error = new Error('original error');

    logger.log('error', 'error', 'test', 'request failed', error);

    expect(Sentry.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ level: 'error' })
    );
    expect(logger.getLogs()[0]?.data).toBe(error);
    expect(() => logger.exportLogs()).not.toThrow();
  });
});
