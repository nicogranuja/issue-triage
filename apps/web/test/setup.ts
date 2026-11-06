import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});

// jsdom implements <dialog> but not its modal methods (they are typed as always present).
const dialog = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
if (typeof dialog.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
    // Like a browser: Esc fires "cancel", then closes the dialog.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.removeEventListener('keydown', onKeyDown);
        this.dispatchEvent(new Event('cancel'));
        this.close();
      }
    };
    this.addEventListener('keydown', onKeyDown);
    // Like a browser: focus moves into the modal.
    this.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus();
  };
}
if (typeof dialog.close !== 'function') {
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}
