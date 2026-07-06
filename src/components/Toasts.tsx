import { useCallback, useRef, useState } from "react";

export interface ToastItem {
  id: number;
  text: string;
  err?: boolean;
}

export type ToastFn = (text: string, err?: boolean) => void;

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const toast = useCallback<ToastFn>((text, err) => {
    const id = ++seq.current;
    setToasts((ts) => [...ts, { id, text, err }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), err ? 6000 : 3200);
  }, []);
  return { toasts, toast };
}

export function ToastHost({ toasts }: { toasts: ToastItem[] }) {
  if (!toasts.length) return null;
  return (
    <div className="toast">
      {toasts.map((t) => (
        <div key={t.id} className={"toast-item" + (t.err ? " err" : "")}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
