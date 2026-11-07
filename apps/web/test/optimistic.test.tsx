import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FakeApi, suggestion } from './fake-api.ts';
import { renderApp, rowTitles, selectedTitle } from './render.tsx';

function deferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

describe('optimistic reviews', () => {
  it('removes the suggestion at once, before the API answers', async () => {
    const api = new FakeApi([suggestion(1), suggestion(2)]);
    const { user } = await renderApp(api);
    await screen.findByRole('heading', { level: 2, name: 'Issue number 1' });
    const gate = deferred();
    api.replyNext({ status: 200 }, gate.promise);

    await user.keyboard('a');

    expect(rowTitles()).toEqual(['Issue number 2']);
    expect(screen.getByRole('button', { name: /To review/ })).toHaveTextContent('1');

    gate.release();
    const status = screen.getByRole('status', { name: '' });
    expect(await within(status).findByText('Accepted #1.')).toBeInTheDocument();
    expect(within(status).getByRole('button', { name: /Undo/ })).toBeInTheDocument();
  });

  it('puts the suggestion back where it was when the API fails, and says so', async () => {
    const api = new FakeApi([suggestion(1), suggestion(2), suggestion(3)]);
    const { user } = await renderApp(api);
    await user.keyboard('j');
    await screen.findByRole('heading', { level: 2, name: 'Issue number 2' });
    const gate = deferred();
    api.replyNext({ status: 500, body: { error: 'Internal Server Error' } }, gate.promise);

    await user.keyboard('a');
    expect(rowTitles()).toEqual(['Issue number 1', 'Issue number 3']);
    gate.release();

    const alert = await screen.findByRole('alert');
    expect(
      await within(alert).findByText(
        'Couldn’t save the review of #2: Internal Server Error. It’s back in the queue.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(rowTitles()).toEqual(['Issue number 1', 'Issue number 2', 'Issue number 3']);
    });
  });

  it('puts back only the failed review, not another one still in flight', async () => {
    const api = new FakeApi([suggestion(1), suggestion(2), suggestion(3)]);
    const { user } = await renderApp(api);
    await screen.findByRole('heading', { level: 2, name: 'Issue number 1' });
    const first = deferred();
    api.replyNext({ status: 500, body: { error: 'Internal Server Error' } }, first.promise);
    await user.keyboard('a');
    await screen.findByRole('heading', { level: 2, name: 'Issue number 2' });
    const second = deferred();
    api.replyNext({ status: 200 }, second.promise);
    await user.keyboard('a');
    expect(rowTitles()).toEqual(['Issue number 3']);

    // The first fails while the second is still waiting for its answer.
    first.release();
    await screen.findByRole('alert');
    await waitFor(() => {
      expect(rowTitles()).toEqual(['Issue number 1', 'Issue number 3']);
    });
    second.release();
    await screen.findByText('Accepted #2.');
  });

  it('shows why when the suggestion is stale (409)', async () => {
    const api = new FakeApi([suggestion(1), suggestion(2)]);
    const { user } = await renderApp(api);
    await screen.findByRole('heading', { level: 2, name: 'Issue number 1' });
    api.replyNext({
      status: 409,
      body: {
        error: 'This suggestion is out of date: the issue changed and was triaged again.',
        code: 'superseded',
        currentSuggestionId: null,
      },
    });
    // The server now says the suggestion was superseded.
    const detail = api.details.get(10);
    if (detail) {
      api.details.set(10, { ...detail, status: 'superseded' });
    }

    await user.keyboard('a');

    const alert = await screen.findByRole('alert');
    expect(
      await within(alert).findByText(
        '#1: This suggestion is out of date: the issue changed and was triaged again.',
      ),
    ).toBeInTheDocument();
    // The reviewer is taken back to it, and the detail explains it can't be reviewed.
    await waitFor(() => {
      expect(selectedTitle()).toBe('Issue number 1');
    });
    expect(await screen.findByText(/Can’t review this one\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Accept/ })).not.toBeInTheDocument();
  });

  it('undoes the last review with u', async () => {
    const api = new FakeApi([suggestion(1), suggestion(2)]);
    const { user } = await renderApp(api);
    await screen.findByRole('heading', { level: 2, name: 'Issue number 1' });

    await user.keyboard('a');
    await screen.findByText('Accepted #1.');
    await user.keyboard('u');

    await waitFor(() => {
      expect(api.undos).toEqual([10]);
    });
    expect(
      await screen.findByText('Undone. The suggestion is back in the queue.'),
    ).toBeInTheDocument();
    // A second u has nothing left to undo.
    await user.keyboard('u');
    expect(api.undos).toEqual([10]);
  });
});
