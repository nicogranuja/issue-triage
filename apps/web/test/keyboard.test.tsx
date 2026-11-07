import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { isTypingTarget } from '../src/hooks/useShortcuts.ts';
import { FakeApi, suggestion } from './fake-api.ts';
import { renderApp, selectedTitle } from './render.tsx';

function threeSuggestions() {
  return new FakeApi([suggestion(1), suggestion(2), suggestion(3)]);
}

async function detailHeading(title: string) {
  return screen.findByRole('heading', { level: 2, name: title });
}

describe('keyboard shortcuts', () => {
  it('moves the selection, and focus with it, with j/k and the arrow keys', async () => {
    const { user } = await renderApp(threeSuggestions());
    await detailHeading('Issue number 1');
    expect(selectedTitle()).toBe('Issue number 1');

    await user.keyboard('j');
    expect(selectedTitle()).toBe('Issue number 2');
    expect(document.activeElement).toHaveAttribute('aria-current', 'true');
    await detailHeading('Issue number 2');

    await user.keyboard('{ArrowDown}');
    expect(selectedTitle()).toBe('Issue number 3');
    await user.keyboard('j');
    expect(selectedTitle()).toBe('Issue number 3');

    await user.keyboard('k');
    await user.keyboard('{ArrowUp}');
    expect(selectedTitle()).toBe('Issue number 1');
  });

  it('accepts with a, rejects with r, and moves on to the next suggestion', async () => {
    const api = threeSuggestions();
    const { user } = await renderApp(api);
    await detailHeading('Issue number 1');

    await user.keyboard('a');
    await waitFor(() => {
      expect(api.reviews).toEqual([{ suggestionId: 10, body: { decision: 'accept' } }]);
    });
    expect(selectedTitle()).toBe('Issue number 2');
    expect(document.activeElement).toHaveAttribute('aria-current', 'true');

    await detailHeading('Issue number 2');
    await user.keyboard('r');
    await waitFor(() => {
      expect(api.reviews.at(-1)).toEqual({ suggestionId: 20, body: { decision: 'reject' } });
    });
    expect(selectedTitle()).toBe('Issue number 3');
  });

  it('does not accept twice when a is held down', async () => {
    const api = threeSuggestions();
    await renderApp(api);
    await detailHeading('Issue number 1');

    fireEvent.keyDown(document.body, { key: 'a' });
    fireEvent.keyDown(document.body, { key: 'a', repeat: true });
    fireEvent.keyDown(document.body, { key: 'a', repeat: true });

    await waitFor(() => {
      expect(api.reviews).toHaveLength(1);
    });
  });

  it('ignores shortcuts with Ctrl, Alt, or Cmd held, so browser shortcuts keep working', async () => {
    const api = threeSuggestions();
    await renderApp(api);
    await detailHeading('Issue number 1');

    fireEvent.keyDown(document.body, { key: 'a', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'r', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'j', altKey: true });

    expect(api.reviews).toEqual([]);
    expect(selectedTitle()).toBe('Issue number 1');
  });

  it('never fires while typing in a field', async () => {
    const api = threeSuggestions();
    const { user } = await renderApp(api);
    await detailHeading('Issue number 1');

    await user.keyboard('e');
    const filter = await screen.findByRole('searchbox', { name: 'Filter labels' });
    expect(filter).toHaveFocus();

    // Every action key, typed into the field.
    await user.keyboard('jkaeruo?');
    expect(filter).toHaveValue('jkaeruo?');
    const note = screen.getByRole('textbox', { name: /Note/ });
    await user.click(note);
    await user.keyboard('a fix for r');
    expect(note).toHaveValue('a fix for r');

    expect(api.reviews).toEqual([]);
    expect(selectedTitle()).toBe('Issue number 1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('edits with e: labels, priority, and note, saved with Cmd+Enter', async () => {
    const api = threeSuggestions();
    const { user } = await renderApp(api);
    await detailHeading('Issue number 1');

    await user.keyboard('e');
    const form = await screen.findByRole('form', { name: 'Edit before applying' });
    await user.click(within(form).getByRole('checkbox', { name: /needs triage/ }));
    await user.click(within(form).getByRole('checkbox', { name: /regression/ }));
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Priority' }), 'urgent');
    await user.type(within(form).getByRole('textbox', { name: /Note/ }), 'Seen twice');

    // The preview shows the change before it is saved.
    const preview = within(form).getByRole('list', { name: 'Labels after this edit' });
    expect(preview).toHaveTextContent('remove: needs triage');
    expect(preview).toHaveTextContent('add: regression');

    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => {
      expect(api.reviews).toEqual([
        {
          suggestionId: 10,
          body: {
            decision: 'edit',
            labels: ['bug', 'regression'],
            baseLabels: ['needs triage'],
            priority: 'urgent',
            note: 'Seen twice',
          },
        },
      ]);
    });
  });

  it('cancels editing with Esc and puts focus back on the list', async () => {
    const api = threeSuggestions();
    const { user } = await renderApp(api);
    await detailHeading('Issue number 1');

    await user.keyboard('e');
    await screen.findByRole('form', { name: 'Edit before applying' });
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('form', { name: 'Edit before applying' })).not.toBeInTheDocument();
    expect(document.activeElement).toHaveAttribute('aria-current', 'true');
    // Shortcuts work again.
    await user.keyboard('j');
    expect(selectedTitle()).toBe('Issue number 2');
    expect(api.reviews).toEqual([]);
  });

  it('opens the detail with Enter, focusing its heading, and goes back with Esc', async () => {
    const { user } = await renderApp(threeSuggestions());
    const heading = await detailHeading('Issue number 1');

    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });

    await user.keyboard('{Escape}');
    expect(document.activeElement).toHaveAttribute('aria-current', 'true');
  });

  it('opens with Enter on a focused row too, focusing the detail', async () => {
    const { user } = await renderApp(threeSuggestions());
    await detailHeading('Issue number 1');

    await user.keyboard('j');
    expect(document.activeElement).toHaveAttribute('aria-current', 'true');
    const heading = await detailHeading('Issue number 2');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  it('shows and hides the shortcut help with ?, and closes it with Esc', async () => {
    const api = threeSuggestions();
    const { user } = await renderApp(api);
    await detailHeading('Issue number 1');

    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByRole('table')).toHaveTextContent('Accept');

    // Other shortcuts are off while it is open.
    await user.keyboard('a');
    expect(api.reviews).toEqual([]);

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await user.keyboard('?');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('?');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});

describe('isTypingTarget', () => {
  it('counts text fields, selects, and editable content, but not buttons', () => {
    document.body.innerHTML = `
      <input id="text" /><input id="box" type="checkbox" /><textarea id="area"></textarea>
      <select id="select"></select><div id="editable" contenteditable="true"><b id="inner">x</b></div>
      <button id="button">b</button>`;
    const element = (id: string) => document.getElementById(id);
    for (const id of ['text', 'box', 'area', 'select', 'inner']) {
      expect(isTypingTarget(element(id)), id).toBe(true);
    }
    expect(isTypingTarget(element('button'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    document.body.innerHTML = '';
  });
});
