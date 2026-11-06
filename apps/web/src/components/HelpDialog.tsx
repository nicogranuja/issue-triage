import { useEffect, useRef } from 'react';

import styles from './HelpDialog.module.css';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const SHORTCUTS: [keys: string[], action: string][] = [
  [['j', '↓'], 'Next suggestion'],
  [['k', '↑'], 'Previous suggestion'],
  [['Enter'], 'Open the suggestion'],
  [['Esc'], 'Close, or cancel editing'],
  [['a'], 'Accept'],
  [['e'], 'Edit, then apply'],
  [['r'], 'Reject'],
  [['u', isMac ? '⌘Z' : 'Ctrl+Z'], 'Undo the last review'],
  [['o'], 'Open the issue on GitHub'],
  [['?'], 'Show or hide these shortcuts'],
];

/**
 * The keyboard shortcuts, in a modal <dialog>: the browser keeps focus inside it, closes it on
 * Esc, and gives focus back to where it was.
 */
export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="help-title"
      onClose={onClose}
      // Esc fires "cancel" at once and "close" a task later; react to the first, so a key
      // pressed right after Esc already reaches the page.
      onCancel={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className={styles.content}>
        <header className={styles.header}>
          <h2 id="help-title">Keyboard shortcuts</h2>
          <button type="button" className={styles.close} onClick={onClose}>
            Close <kbd aria-hidden="true">Esc</kbd>
          </button>
        </header>
        <table className={styles.table}>
          <thead className="visually-hidden">
            <tr>
              <th scope="col">Keys</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map(([keys, action]) => (
              <tr key={action}>
                <td>
                  {keys.map((key, index) => (
                    <span key={key}>
                      {index > 0 && <span className={styles.or}> or </span>}
                      <kbd className={styles.kbd}>{key}</kbd>
                    </span>
                  ))}
                </td>
                <td>{action}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.note}>Shortcuts are off while you type in a field.</p>
      </div>
    </dialog>
  );
}
