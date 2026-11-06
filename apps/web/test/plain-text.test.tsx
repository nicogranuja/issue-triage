import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FakeApi, suggestion } from './fake-api.ts';
import { renderApp } from './render.tsx';

const TITLE = '<img src=x onerror=alert(1)>';

describe('untrusted text', () => {
  it('renders an issue title with HTML in it as plain text, in the list and the detail', async () => {
    const entry = suggestion(1, {
      title: TITLE,
      summary: '<script>alert("summary")</script> **bold** [link](javascript:alert(1))',
    });
    entry.detail.labels.rationale = '<b onmouseover=alert(1)>rationale</b>';
    entry.detail.issue.body = '<iframe src="https://example.com"></iframe>\n# Heading';
    const { container } = await renderApp(new FakeApi([entry]));

    const heading = await screen.findByRole('heading', { level: 2, name: TITLE });
    expect(heading.textContent).toBe(TITLE);
    const list = screen.getByRole('list', { name: 'Suggestions to review' });
    expect(within(list).getByText(TITLE)).toBeInTheDocument();

    expect(
      screen.getByText(/<script>alert\("summary"\)<\/script> \*\*bold\*\*/),
    ).toBeInTheDocument();
    expect(screen.getByText('<b onmouseover=alert(1)>rationale</b>')).toBeInTheDocument();
    expect(screen.getByText(/<iframe src=/)).toBeInTheDocument();

    // Nothing the text describes became an element.
    for (const tag of ['img', 'script', 'iframe', 'b']) {
      expect(container.querySelector(tag), tag).toBeNull();
    }
    // In the markup it only exists escaped, as text.
    expect(container.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(container.innerHTML).not.toContain('<img');
    expect(document.title).not.toContain('<img');
  });

  it('only links to http(s) URLs, and only uses hex label colors', async () => {
    const entry = suggestion(1, { htmlUrl: 'javascript:alert(1)' });
    entry.detail.duplicates.issues = [
      {
        issueId: 7,
        number: 7,
        title: 'A duplicate',
        state: 'closed',
        htmlUrl: 'data:text/html,<script>alert(1)</script>',
        reason: 'Same thing.',
      },
    ];
    entry.detail.repository.labels = [
      { name: 'bug', description: null, color: 'red;background-image:url(https://x.test)' },
    ];
    const { container } = await renderApp(new FakeApi([entry]));
    await screen.findByRole('heading', { level: 2, name: 'Issue number 1' });

    expect(screen.getByText('#1 on GitHub').closest('a')).toBeNull();
    expect(screen.getByText(/A duplicate/).closest('a')).toBeNull();
    for (const link of container.querySelectorAll('a')) {
      expect(link.getAttribute('href')).toMatch(/^https?:/);
    }
    expect(container.innerHTML).not.toContain('background-image');
  });
});
