import { expect, test } from '@playwright/test';
import { issueTitle, renameIssue } from './helpers/issues.ts';
import { signInAs } from './helpers/sign-in.ts';

test("an owner's title edit reaches a member's open page within 5 s and survives reload", async ({
  browser,
}) => {
  const owner = await (await browser.newContext()).newPage();
  const member = await (await browser.newContext()).newPage();
  await signInAs(owner, 'owner');
  await signInAs(member, 'member');
  await expect(issueTitle(member, 3)).toHaveText('ENG issue 3');

  const title = `Synced ${crypto.randomUUID().slice(0, 8)}`;
  await renameIssue(owner, 3, title);

  await expect(issueTitle(member, 3)).toHaveText(title, { timeout: 5000 });
  await owner.reload();
  await expect(issueTitle(owner, 3)).toHaveText(title);
  await member.context().close();
  await owner.context().close();
});

test('a rejected write rolls back the title and shows a translated message', async ({
  browser,
}) => {
  const owner = await (await browser.newContext()).newPage();
  await signInAs(owner, 'owner');
  await owner.route('**/api/w/*/issues/*', (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'invalid_state', message: 'developer text that the page must not show' },
    }),
  );

  await renameIssue(owner, 4, 'Will be rejected');

  await expect(owner.getByTestId('mutation-error')).toHaveText(
    "The state does not belong to the issue's team.",
  );
  await expect(issueTitle(owner, 4)).toHaveText('ENG issue 4');
  await owner.context().close();
});
