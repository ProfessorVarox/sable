import { describe, expect, it, vi } from 'vitest';

import type { MatrixClient } from '$types/matrix-sdk';
import { MATRIX_UNSTABLE_MSC4461_ACCOUNT_PER_MESSAGE_PROFILES_PROPERTY_NAME } from '$unstable/prefixes';
import {
  addOrUpdatePerMessageProfile,
  deletePerMessageProfile,
  getAllPerMessageProfiles,
  renamePerMessageProfile,
  type PerMessageProfileMsc4461,
} from './usePerMessageProfile';

function createMatrixClient(profiles: PerMessageProfileMsc4461[] = []) {
  const accountData = new Map<string, unknown>();
  accountData.set(MATRIX_UNSTABLE_MSC4461_ACCOUNT_PER_MESSAGE_PROFILES_PROPERTY_NAME, {
    profiles,
  });

  const mx = {
    getAccountData: vi.fn<(eventType: string) => { getContent: () => unknown } | undefined>(
      (eventType) => {
        const content = accountData.get(eventType);
        return content === undefined ? undefined : { getContent: () => content };
      }
    ),
    setAccountData: vi.fn<(eventType: string, content: unknown) => Promise<void>>(
      async (eventType, content) => {
        accountData.set(eventType, content);
      }
    ),
    deleteAccountData: vi.fn<(eventType: string) => Promise<void>>(async (eventType) => {
      accountData.delete(eventType);
    }),
  } as unknown as MatrixClient;

  return { accountData, mx };
}

const profile = (id: string): PerMessageProfileMsc4461 => ({
  id,
  displayname: `Profile ${id}`,
  trigger: { prefix: [] },
});

describe('profile persistence', () => {
  it('creates and updates profiles', async () => {
    const original = profile('first');
    const { mx } = createMatrixClient([original]);
    const replacement = { ...original, displayname: 'Replacement' };

    await addOrUpdatePerMessageProfile(mx, replacement);
    await addOrUpdatePerMessageProfile(mx, profile('second'));

    await expect(getAllPerMessageProfiles(mx)).resolves.toEqual([replacement, profile('second')]);
    expect(original.displayname).toBe('Profile first');
  });

  it('awaits account-data writes', async () => {
    let completeWrite!: () => void;
    const mx = {
      getAccountData: vi.fn<() => undefined>(() => undefined),
      setAccountData: vi.fn<() => Promise<void>>(
        () =>
          new Promise<void>((resolve) => {
            completeWrite = resolve;
          })
      ),
    } as unknown as MatrixClient;
    const saving = addOrUpdatePerMessageProfile(mx, profile('profile-id'));
    let saved = false;
    void saving.then(() => {
      saved = true;
    });

    await Promise.resolve();
    expect(saved).toBe(false);

    completeWrite();
    await saving;
  });

  it('reads nested payloads', async () => {
    const nestedProfile = profile('nested');
    const { accountData, mx } = createMatrixClient();
    accountData.set(MATRIX_UNSTABLE_MSC4461_ACCOUNT_PER_MESSAGE_PROFILES_PROPERTY_NAME, {
      type: 'm.per_message_profiles',
      content: { profiles: [nestedProfile] },
    });

    await expect(getAllPerMessageProfiles(mx)).resolves.toEqual([nestedProfile]);
  });

  it('migrates legacy profiles', async () => {
    const { accountData, mx } = createMatrixClient();
    accountData.delete(MATRIX_UNSTABLE_MSC4461_ACCOUNT_PER_MESSAGE_PROFILES_PROPERTY_NAME);
    accountData.set('fyi.cisnt.permessageprofile.index', { profileIds: ['legacy'] });
    accountData.set('fyi.cisnt.permessageprofile.legacy', {
      id: 'legacy',
      name: 'Legacy profile',
    });

    const migratedProfile = {
      id: 'legacy',
      displayname: 'Legacy profile',
      trigger: { prefix: [], 'net.f0rest.suffix': [], 'net.f0rest.circumfix': [] },
    };

    await expect(getAllPerMessageProfiles(mx)).resolves.toEqual([migratedProfile]);
    expect(
      accountData.get(MATRIX_UNSTABLE_MSC4461_ACCOUNT_PER_MESSAGE_PROFILES_PROPERTY_NAME)
    ).toEqual({
      profiles: [migratedProfile],
    });
    expect(accountData.has('fyi.cisnt.permessageprofile.index')).toBe(false);
    expect(accountData.has('fyi.cisnt.permessageprofile.legacy')).toBe(false);
  });

  it('deletes profiles', async () => {
    const { mx } = createMatrixClient([profile('first'), profile('second')]);

    await deletePerMessageProfile(mx, 'first');

    await expect(getAllPerMessageProfiles(mx)).resolves.toEqual([profile('second')]);
  });

  it('renames profiles', async () => {
    const { mx } = createMatrixClient([profile('old-id')]);

    await renamePerMessageProfile(mx, 'old-id', 'new-id');

    await expect(getAllPerMessageProfiles(mx)).resolves.toEqual([
      { ...profile('old-id'), id: 'new-id' },
    ]);
  });
});
