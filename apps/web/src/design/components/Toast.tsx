import { X } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cx } from '../cx.ts';
import { useT } from '../locale.tsx';
import { Button } from './Button.tsx';
import { IconButton } from './IconButton.tsx';

export type ToastInput = {
  message: string;
  tone?: 'info' | 'error';
  actionLabel?: string;
  onAction?: () => void;
};

type ToastItem = ToastInput & { id: number };

/** An info toast leaves by itself after this long; an error stays until it is dismissed. */
const AUTO_DISMISS_MS = 6000;

const ToastContext = createContext<{ show: (toast: ToastInput) => void } | undefined>(undefined);

export function useToast(): { show: (toast: ToastInput) => void } {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast needs a ToastProvider above it');
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const hold = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const schedule = useCallback(
    (id: number) => {
      hold(id);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
      );
    },
    [dismiss, hold],
  );

  const show = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setItems((current) => [...current, { ...toast, id }]);
      if (toast.tone !== 'error') schedule(id);
    },
    [schedule],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-viewport">
        {items.map((item) => {
          const error = item.tone === 'error';
          // Pointer or keyboard attention pauses the countdown, so an action cannot vanish under the cursor.
          const pausable = error
            ? {}
            : {
                onMouseEnter: () => hold(item.id),
                onMouseLeave: () => schedule(item.id),
                onFocus: () => hold(item.id),
                onBlur: () => schedule(item.id),
              };
          return (
            <div
              key={item.id}
              role={error ? 'alert' : 'status'}
              className={cx('toast', error && 'toast--error')}
              {...pausable}
            >
              <span className="toast__message">{item.message}</span>
              {item.actionLabel ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    item.onAction?.();
                    dismiss(item.id);
                  }}
                >
                  {item.actionLabel}
                </Button>
              ) : null}
              <IconButton
                label={t('common.close')}
                icon={<X size={14} aria-hidden="true" />}
                tooltip={false}
                size="sm"
                onClick={() => dismiss(item.id)}
              />
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
