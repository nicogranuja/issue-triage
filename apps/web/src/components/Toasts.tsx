import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import styles from './Toasts.module.css';

export interface ToastOptions {
  message: string;
  tone?: 'info' | 'error';
  /** One button, such as Undo. */
  action?: { label: string; shortcut?: string; run: () => void };
  /** How long the toast stays; hovering or focusing it pauses the clock. */
  durationMs?: number;
}

interface Toast extends ToastOptions {
  id: number;
}

interface ToastApi {
  show: (toast: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToasts(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    throw new Error('useToasts must be used inside <ToastProvider>');
  }
  return api;
}

const MAX_TOASTS = 3;

/**
 * Short confirmations and errors at the bottom of the screen. They are announced through two
 * live regions that are always in the page (a region added together with its message is often
 * not read out): polite for confirmations, assertive for errors.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const schedule = useCallback(
    (id: number, ms: number) => {
      clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        setTimeout(() => {
          dismiss(id);
        }, ms),
      );
    },
    [dismiss],
  );

  const show = useCallback(
    (options: ToastOptions) => {
      const id = nextId.current++;
      const toast: Toast = { ...options, id };
      setToasts((current) => [...current, toast].slice(-MAX_TOASTS));
      schedule(id, toastDuration(toast));
      return id;
    },
    [schedule],
  );

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  const pause = (id: number) => {
    clearTimeout(timers.current.get(id));
  };
  const resume = (toast: Toast) => {
    schedule(toast.id, 2_000);
  };

  const render = (tone: 'info' | 'error') =>
    toasts
      .filter((toast) => (toast.tone ?? 'info') === tone)
      .map((toast) => (
        <div
          key={toast.id}
          className={styles.toast}
          data-tone={tone}
          onMouseEnter={() => {
            pause(toast.id);
          }}
          onMouseLeave={() => {
            resume(toast);
          }}
          onFocus={() => {
            pause(toast.id);
          }}
          onBlur={() => {
            resume(toast);
          }}
        >
          {tone === 'error' && (
            <span className={styles.icon} aria-hidden="true">
              !
            </span>
          )}
          <p className={styles.message}>{toast.message}</p>
          {toast.action && (
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                toast.action?.run();
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
              {toast.action.shortcut && (
                <kbd className={styles.kbd} aria-hidden="true">
                  {toast.action.shortcut}
                </kbd>
              )}
            </button>
          )}
          <button
            type="button"
            className={styles.close}
            aria-label="Dismiss"
            onClick={() => {
              dismiss(toast.id);
            }}
          >
            ×
          </button>
        </div>
      ));

  return (
    <ToastContext value={api}>
      {children}
      <div className={styles.stack}>
        <div role="status" aria-live="polite" className={styles.region}>
          {render('info')}
        </div>
        <div role="alert" aria-live="assertive" className={styles.region}>
          {render('error')}
        </div>
      </div>
    </ToastContext>
  );
}

function toastDuration(toast: ToastOptions): number {
  return toast.durationMs ?? (toast.tone === 'error' ? 8_000 : 5_000);
}
