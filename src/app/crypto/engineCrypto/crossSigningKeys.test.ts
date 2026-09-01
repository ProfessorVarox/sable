import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from '$types/matrix-sdk';
import { engineInvoke } from '../olmMachine/engineInvoke';
import { EngineCrypto } from './EngineCrypto';

vi.mock('../olmMachine/engineInvoke', () => ({
  engineInvoke: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

const mockInvoke = vi.mocked(engineInvoke);

const invoked = (method: string) => mockInvoke.mock.calls.filter(([, called]) => called === method);

const crypto = () =>
  new EngineCrypto(
    {
      http: { authedRequest: vi.fn<(...args: never[]) => Promise<string>>(async () => '{}') },
    } as unknown as MatrixClient,
    {
      userId: '@me:e.org',
      deviceId: 'D',
    }
  );

describe('userHasCrossSigningKeys', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('refreshes keys/query before answering for our own user', async () => {
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'queryKeysForUsers') return { id: 'q1', type: 1, body: '{}' };
      if (method === 'getIdentity') return { isVerified: false };
      return null;
    });

    await expect(crypto().userHasCrossSigningKeys()).resolves.toBe(true);

    const order = mockInvoke.mock.calls.map(([, method]) => method);
    expect(order.indexOf('queryKeysForUsers')).toBeLessThan(order.indexOf('getIdentity'));
    expect(invoked('queryKeysForUsers')[0]?.[2]).toMatchObject({ users: ['@me:e.org'] });
  });

  it('reports no identity for our own user only after a successful refresh', async () => {
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'queryKeysForUsers') return null;
      if (method === 'getIdentity') return null;
      return null;
    });

    await expect(crypto().userHasCrossSigningKeys()).resolves.toBe(false);
    expect(invoked('queryKeysForUsers')).toHaveLength(1);
  });

  it('does not query for another user unless asked to', async () => {
    mockInvoke.mockImplementation(async (_identity, method) =>
      method === 'getIdentity' ? null : null
    );

    await expect(crypto().userHasCrossSigningKeys('@them:e.org')).resolves.toBe(false);
    expect(invoked('queryKeysForUsers')).toHaveLength(0);
  });

  it('queries for another user when downloadUncached is set', async () => {
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'queryKeysForUsers') return { id: 'q1', type: 1, body: '{}' };
      if (method === 'getIdentity') return { isVerified: false };
      return null;
    });

    await expect(crypto().userHasCrossSigningKeys('@them:e.org', true)).resolves.toBe(true);
    expect(invoked('queryKeysForUsers')[0]?.[2]).toMatchObject({ users: ['@them:e.org'] });
  });
});
