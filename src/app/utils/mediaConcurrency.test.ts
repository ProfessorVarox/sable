import { describe, expect, it } from 'vitest';
import { withMediaFetchSlot } from './mediaConcurrency';

describe('withMediaFetchSlot', () => {
  it('never runs more than three tasks at once and runs all of them', async () => {
    let active = 0;
    let peak = 0;
    const release: (() => void)[] = [];

    const tasks = Array.from({ length: 10 }, () =>
      withMediaFetchSlot(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => {
          release.push(resolve);
        });
        active -= 1;
      })
    );

    while (release.length > 0) {
      release.shift()?.();
      // Let the freed slot reach the next waiter before draining again.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }

    await Promise.all(tasks);
    expect(peak).toBe(3);
  });

  it('releases the slot when a task rejects', async () => {
    await expect(withMediaFetchSlot(() => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    );

    await expect(withMediaFetchSlot(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
