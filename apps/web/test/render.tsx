import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { App } from '../src/App.tsx';
import { ToastProvider } from '../src/components/Toasts.tsx';
import type { FakeApi } from './fake-api.ts';

/** Renders the whole app against a fake API, and waits for the queue to load. */
export async function renderApp(api: FakeApi) {
  vi.stubGlobal('fetch', api.fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>,
  );
  const list = await screen.findByRole('list', { name: 'Suggestions to review' });
  return { ...view, user, client, list };
}

/** The queue rows' titles, in order. */
export function rowTitles(): string[] {
  const list = screen.queryByRole('list', { name: 'Suggestions to review' });
  return list
    ? within(list)
        .getAllByRole('button')
        .map((row) => row.querySelector('[class*="title"]')?.textContent ?? '')
    : [];
}

/** The title of the row marked as selected. */
export function selectedTitle(): string | null {
  const row = document.querySelector('[aria-current="true"]');
  return row?.querySelector('[class*="title"]')?.textContent ?? null;
}
