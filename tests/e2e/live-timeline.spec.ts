import { test, expect } from './fixtures/test';
import {
  createRoom,
  getRoomMessages,
  inviteUser,
  joinRoom,
  registerUser,
  sendText,
} from './fixtures/continuwuity';
import { AppShell } from './pages/AppShell';
import { homeserverBaseUrl, loginAsFreshUser, PASSWORD } from './fixtures/session';
const BURST_SIZE = 8;

test.describe('live timeline', () => {
  test('renders an editor-sent message as a single server-confirmed row', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop-focused');
    test.setTimeout(300_000);
    const storageStatePath = testInfo.project.use.storageState as string;
    const hsBaseUrl = await homeserverBaseUrl(storageStatePath);
    const tag = `send-${process.pid}-${Date.now().toString(36)}`;
    const app = new AppShell(page);
    const user = await loginAsFreshUser(page, hsBaseUrl, `${tag}-u`);

    const room = await createRoom(hsBaseUrl, user.accessToken, {
      name: `${tag} Room`,
      preset: 'private_chat',
    });

    await page.goto('/');
    await expect(page.getByText(`${tag} Room`).first()).toBeVisible({
      timeout: 180_000,
    });
    await app.openRoom(`${tag} Room`);

    const body = `${tag}-hello`;
    const editor = page.locator('[data-editable-name="RoomInput"]');
    await editor.click();
    await editor.pressSequentially(body);
    await editor.press('Enter');

    await expect(page.getByText(body, { exact: true })).toBeVisible({
      timeout: 120_000,
    });

    let serverId: string | undefined;
    await expect(async () => {
      const messages = await getRoomMessages(hsBaseUrl, user.accessToken, room);
      serverId = messages.find((m) => m.body === body)?.eventId;
      expect(serverId).toMatch(/^\$/);
    }).toPass({ timeout: 120_000, intervals: [500] });

    await expect(app.messageByEventId(serverId!).getByText(body, { exact: true })).toHaveCount(1);
    expect(await page.getByText(body, { exact: true }).count()).toBe(1);
  });

  test('renders a remote burst in an open room exactly once and in canonical order', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop-focused');
    test.setTimeout(300_000);
    const storageStatePath = testInfo.project.use.storageState as string;
    const hsBaseUrl = await homeserverBaseUrl(storageStatePath);
    const tag = `burst-${process.pid}-${Date.now().toString(36)}`;
    const app = new AppShell(page);
    const user = await loginAsFreshUser(page, hsBaseUrl, `${tag}-u`);
    const remote = await registerUser(hsBaseUrl, `${tag}-r`, PASSWORD);

    const room = await createRoom(hsBaseUrl, user.accessToken, {
      name: `${tag} Room`,
      preset: 'private_chat',
    });
    await inviteUser(hsBaseUrl, user.accessToken, room, remote.userId);
    await joinRoom(hsBaseUrl, remote.accessToken, room);
    const readyEventId = await sendText(hsBaseUrl, user.accessToken, room, `${tag}-ready`, 1);

    await page.goto('/');
    await expect(page.getByText(`${tag} Room`).first()).toBeVisible({
      timeout: 180_000,
    });
    await app.openRoom(`${tag} Room`);
    await expect(app.messageByEventId(readyEventId)).toBeVisible({ timeout: 120_000 });

    for (let i = 1; i <= BURST_SIZE; i += 1) {
      await sendText(hsBaseUrl, remote.accessToken, room, `${tag}-b${i}`, i);
    }

    const expected = (await getRoomMessages(hsBaseUrl, user.accessToken, room))
      .filter((m) => m.body.startsWith(`${tag}-b`))
      .map((m) => m.body);
    expect(expected).toEqual(Array.from({ length: BURST_SIZE }, (_, i) => `${tag}-b${i + 1}`));

    for (const body of expected) {
      await expect(page.getByText(body, { exact: true })).toHaveCount(1, {
        timeout: 120_000,
      });
    }

    const domOrder = await page.getByText(new RegExp(`^${tag}-b\\d+$`)).allTextContents();
    expect(domOrder).toEqual(expected);
  });
});
