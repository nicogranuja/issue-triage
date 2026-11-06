import { expect, test } from '@playwright/test';

// Only the fields checked here. (The spec doesn't import @issue-triage/shared: Playwright loads
// it through Node, which resolves the package to its build output, not its sources.)
interface RecentReviews {
  items: { review: Record<string, unknown> }[];
}

test('accept with the keyboard: the item leaves the queue and its write-back is recorded', async ({
  page,
  request,
}) => {
  await page.goto('/');

  const queue = page.getByRole('list', { name: 'Suggestions to review' });
  const first = queue.getByRole('button').first();
  await expect(first).toHaveAttribute('aria-current', 'true');
  const title = 'Config file with an API key is world-readable after install';
  await expect(first).toContainText(title);
  await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
  const count = page.getByRole('button', { name: /To review/ });
  await expect(count).toContainText('11');

  await page.keyboard.press('a');

  await expect(queue.getByText(title)).toHaveCount(0);
  await expect(count).toContainText('10');
  await expect(page.getByRole('status').getByText('Accepted #214.')).toBeVisible();
  // The next suggestion is selected and focused, ready for the next key.
  await expect(queue.getByRole('button').first()).toBeFocused();

  // The review's write-back job was recorded with it, and runs once the undo window passes.
  await expect
    .poll(
      async () => {
        const response = await request.get('/api/reviews');
        const { items } = (await response.json()) as RecentReviews;
        return items[0]?.review;
      },
      { timeout: 15_000 },
    )
    .toMatchObject({
      decision: 'accepted',
      labelsAdded: ['bug', 'security', 'platform: linux', 'priority: urgent'],
      writeBack: {
        status: 'succeeded',
        result: {
          added: ['bug', 'security', 'platform: linux', 'priority: urgent'],
          removed: [],
          skipped: [],
          dryRun: true,
        },
      },
    });

  await page.getByRole('button', { name: 'Reviewed' }).click();
  const reviewed = page.getByRole('list', { name: 'Recent reviews' });
  await expect(reviewed).toContainText(title);
  await expect(reviewed).toContainText(
    'Dry run, nothing written: would have added bug, security, platform: linux, priority: urgent.',
  );
});
