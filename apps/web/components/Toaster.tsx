"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import styles from "./toaster.module.css";

type Tone = "success" | "error" | "info";

interface Toast {
  id: number;
  tone: Tone;
  title: string;
  detail?: string;
  href?: string;
  hrefLabel?: string;
}

type Push = (t: Omit<Toast, "id">) => void;

const ToastContext = createContext<Push>(() => {});

/** Toasts for the outcome of anything a person starts: wallet actions, payments, copying. */
export function useToast(): Push {
  return useContext(ToastContext);
}

export function Toaster({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback<Push>((t) => {
    const id = next.current++;
    // Newest last, at most four on screen.
    setToasts((all) => [...all.slice(-3), { ...t, id }]);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <ol className={styles.stack} aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDone={() => dismiss(t.id)} />
        ))}
      </ol>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    // Errors stay longer: they usually say what to do next.
    const t = setTimeout(onDone, toast.tone === "error" ? 9_000 : 5_000);
    return () => clearTimeout(t);
  }, [paused, onDone, toast.tone]);
  return (
    <li
      className={`${styles.toast} ${styles[toast.tone]}`}
      role={toast.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className={styles.body}>
        <p className={styles.title}>{toast.title}</p>
        {toast.detail ? <p className={styles.detail}>{toast.detail}</p> : null}
        {toast.href ? (
          <a className={styles.link} href={toast.href} target="_blank" rel="noreferrer">
            {toast.hrefLabel ?? "Open"}
          </a>
        ) : null}
      </div>
      <button type="button" className={styles.close} onClick={onDone} aria-label="Dismiss">
        ×
      </button>
    </li>
  );
}
