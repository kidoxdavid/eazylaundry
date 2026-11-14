import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { forwardRef, useEffect, useId, useRef } from 'react';
import { ApiError } from '../api';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

export function Button({ variant = 'primary', loading, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; loading?: boolean }) {
  const styles = { primary: 'bg-accent text-white hover:bg-accent-strong', secondary: 'bg-white border border-line hover:bg-surface',
    danger: 'bg-danger text-white hover:opacity-90', ghost: 'hover:bg-surface' }[variant];
  return <button {...p} disabled={p.disabled || loading} className={cx('inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium disabled:opacity-50', styles, className)}>
    {loading ? 'Working…' : children}</button>;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} {...p} className={cx('h-9 w-full rounded-md border border-line bg-white px-3 text-sm', className)} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...p }, ref) {
  return <select ref={ref} {...p} className={cx('h-9 w-full rounded-md border border-line bg-white px-2 text-sm', className)} />;
});

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: (id: string, describedBy?: string) => ReactNode }) {
  const id = useId(); const dId = `${id}-d`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      {children(id, error || hint ? dId : undefined)}
      {(error || hint) && <p id={dId} role={error ? 'alert' : undefined} className={cx('text-xs', error ? 'text-danger' : 'text-muted')}>{error ?? hint}</p>}
    </div>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div role="alert" className="rounded-md border border-danger/30 bg-red-50 px-3 py-2 text-sm text-danger">
      {e.message || 'Something went wrong'}{e.issues?.length ? <ul className="mt-1 list-disc pl-5">{e.issues.map((i) => <li key={i.path + i.message}>{i.path}: {i.message}</li>)}</ul> : null}
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div><h1 className="text-xl font-semibold">{title}</h1>{subtitle && <p className="text-muted">{subtitle}</p>}</div>{action}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning' | 'danger'; children: ReactNode }) {
  const t = { neutral: 'bg-surface text-muted', success: 'bg-green-50 text-success', warning: 'bg-amber-50 text-warning', danger: 'bg-red-50 text-danger' }[tone];
  return <span className={cx('inline-flex rounded px-2 py-0.5 text-xs font-medium', t)}>{children}</span>;
}

export function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line bg-surface text-xs uppercase tracking-wide text-muted"><tr>{head.map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,button')?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('keydown', esc); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center bg-black/30 p-4 pt-24" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <h2 className="mb-4 text-base font-semibold">{title}</h2>{children}
      </div>
    </div>
  );
}
