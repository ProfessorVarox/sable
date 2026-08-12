import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { registerUser, type RegisteredUser } from './continuwuity';

export const PASSWORD = 'test-passw0rd';

export type InjectedSession = {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  slidingSyncOptIn?: boolean;
};

/** Reads the homeserver the global setup provisioned out of the saved storage state. */
export async function homeserverBaseUrl(storageStatePath: string): Promise<string> {
  const state = JSON.parse(await readFile(storageStatePath, 'utf8')) as {
    origins: { localStorage: { name: string; value: string }[] }[];
  };
  const entry = state.origins[0]!.localStorage.find((item) => item.name === 'matrixSessions')!;
  return (JSON.parse(entry.value) as InjectedSession[])[0]!.baseUrl;
}

/**
 * Registers a throwaway account and injects its session before first paint, so a
 * test starts from a known-empty account instead of the shared login fixture.
 */
export async function loginAsFreshUser(
  page: Page,
  baseUrl: string,
  name: string,
  slidingSyncOptIn = true
): Promise<RegisteredUser> {
  const user = await registerUser(baseUrl, name, PASSWORD);
  const session: InjectedSession = {
    baseUrl,
    userId: user.userId,
    deviceId: user.deviceId,
    accessToken: user.accessToken,
    slidingSyncOptIn,
  };
  await page.addInitScript((injected: InjectedSession) => {
    localStorage.setItem('matrixSessions', JSON.stringify([injected]));
    localStorage.setItem('matrixActiveSession', JSON.stringify(injected.userId));
    localStorage.setItem('dismissNotice', 'true');
  }, session);
  return user;
}
