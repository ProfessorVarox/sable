import { test as base } from '@playwright/test';
import { AppShell } from '../pages/AppShell';

type Fixtures = {
  app: AppShell;
};

export const test = base.extend<Fixtures>({
  app: async ({ page }, use) => {
    const app = new AppShell(page);
    await app.open();
    await use(app);
  },
});

export { expect } from '@playwright/test';
