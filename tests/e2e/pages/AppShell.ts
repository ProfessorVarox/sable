import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export const CLIENT_READY_TIMEOUT = 30_000;

export class AppShell {
  readonly leaveRoomPrompt: Locator;

  readonly createRoomButton: Locator;

  constructor(readonly page: Page) {
    this.leaveRoomPrompt = page.getByText('Are you sure you want to leave this room?');
    this.createRoomButton = page.getByRole('button', { name: 'Create Room' }).first();
  }

  messageByEventId(eventId: string): Locator {
    const escaped = eventId.replace(/(["\\])/g, '\\$1');
    return this.page.locator(`[data-message-id="${escaped}"]`);
  }

  async sendTextMessage(text: string): Promise<void> {
    await this.page.locator('div[data-slate-editor="true"]').last().click();
    await this.page.keyboard.type(text);
    await this.page.keyboard.press('Enter');
  }

  async open(): Promise<void> {
    await this.page.addInitScript(() => localStorage.setItem('dismissNotice', 'true'));
    await this.page.goto('/');
    await expect(this.room('General')).toBeVisible({ timeout: CLIENT_READY_TIMEOUT });
  }

  room(name: string): Locator {
    return this.page.getByText(name).first();
  }

  async openRoom(name: string): Promise<void> {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await this.page.getByRole('button', { name: new RegExp(`^${escaped}`) }).click();
  }

  async openRoomOptions(name: string): Promise<RoomOptionsMenu> {
    await this.room(name).hover();
    await this.page.getByRole('button', { name: 'More Options' }).first().click();
    return new RoomOptionsMenu(this.page);
  }
}

export class RoomOptionsMenu {
  constructor(readonly page: Page) {}

  async leaveRoom(): Promise<void> {
    await this.page.getByRole('button', { name: 'Leave Room' }).click();
  }
}
