import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/** README screenshots of the demo data, light and dark: `npm run screenshots -w @issue-triage/web`. */
const docs = (name: string) => fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url));

async function settle(page: Page) {
  // Wait for fonts and any entry animation, so images are stable.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test(`queue (${scheme})`, async ({ page }) => {
      await page.goto('/');
      await expect(
        page.getByRole('heading', { level: 2, name: /Config file with an API key/ }),
      ).toBeVisible();
      await page.keyboard.press('j');
      await page.keyboard.press('j');
      await page.keyboard.press('j');
      await expect(page.getByRole('heading', { level: 2, name: /PDF export/ })).toBeVisible();
      await settle(page);
      await page.screenshot({ path: docs(`queue-${scheme}.png`) });
    });

    test(`detail, editing (${scheme})`, async ({ page }) => {
      await page.setViewportSize({ width: 1180, height: 940 });
      await page.goto('/');
      const row = page
        .getByRole('list', { name: 'Suggestions to review' })
        .getByRole('button', { name: /Alert notifications are sent twice/ });
      await row.click();
      await page.keyboard.press('Escape');
      await page.keyboard.press('e');
      const form = page.getByRole('form', { name: 'Edit before applying' });
      await form.getByRole('checkbox', { name: /needs triage/ }).click();
      await form.getByRole('textbox', { name: /Note/ }).fill('Same root cause as #1290?');
      await form.getByRole('checkbox', { name: /needs triage/ }).focus();
      await settle(page);
      await page.screenshot({ path: docs(`detail-${scheme}.png`) });
    });
  });
}
