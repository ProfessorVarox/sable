import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { createRoom, sendText, startContinuwuity } from './fixtures/continuwuity';

type InjectedSession = {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
};

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const { baseURL, storageState } = config.projects[0]!.use;
  const authPath = storageState as string;

  const hs = await startContinuwuity();
  const user = await hs.register('alice', 'test-passw0rd');

  const general = await createRoom(hs.baseUrl, user.accessToken, {
    name: 'General',
    preset: 'private_chat',
  });
  await sendText(hs.baseUrl, user.accessToken, general, 'Welcome to the test room.', 1);
  await sendText(hs.baseUrl, user.accessToken, general, 'Layout baseline seed message.', 2);

  const random = await createRoom(hs.baseUrl, user.accessToken, {
    name: 'Random',
    preset: 'private_chat',
  });
  await sendText(hs.baseUrl, user.accessToken, random, 'Another seeded room.', 1);

  const space = await createRoom(hs.baseUrl, user.accessToken, {
    name: 'Test Space',
    preset: 'private_chat',
    creation_content: { type: 'm.space' },
  });
  process.env.SEEDED_SPACE_ID = space;

  const session: InjectedSession = {
    baseUrl: hs.baseUrl,
    userId: user.userId,
    deviceId: user.deviceId,
    accessToken: user.accessToken,
  };

  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(
    authPath,
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: new URL(baseURL!).origin,
          localStorage: [
            { name: 'matrixSessions', value: JSON.stringify([session]) },
            { name: 'matrixActiveSession', value: JSON.stringify(session.userId) },
          ],
        },
      ],
    })
  );

  return async () => {
    await hs.stop();
  };
}
