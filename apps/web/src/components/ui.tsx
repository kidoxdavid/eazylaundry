import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { forwardRef, useEffect, useId, useRef } from 'react';
import { ApiError } from '../api';
import { Icon, type IconName } from './icons';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

export function Button({ variant = 'primary', loading, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; loading?: boolean }) {
  const styles = {
    primary: 'bg-gradient-to-b from-accent to-accent-strong text-white shadow-sm shadow-accent/30 hover:brightness-110',
    secondary: 'bg-white border border-line text-ink shadow-sm hover:border-accent/40 hover:bg-tint/40',
    danger: 'bg-danger text-white shadow-sm hover:brightness-110', ghost: 'text-ink hover:bg-tint/60',
  }[variant];
  return <button {...p} disabled={p.disabled || loading} aria-busy={loading || undefined}
    className={cx('inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-base font-medium transition active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100 md:h-9 md:px-3.5 md:text-sm', styles, className)}>
    {loading ? <><span className="spinner" aria-hidden="true" />Working…</> : children}</button>;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} {...p} className={cx('h-11 w-full card px-3 text-base md:h-9 md:text-sm', className)} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...p }, ref) {
  return <select ref={ref} {...p} className={cx('h-11 w-full card px-2 text-base md:h-9 md:text-sm', className)} />;
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
    <div className="page-enter mb-5 flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">{title}</h1>{subtitle && <p className="mt-0.5 text-muted">{subtitle}</p>}</div>{action}
    </div>
  );
}

const DOT = { neutral: 'bg-muted/60', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' };
export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning' | 'danger'; children: ReactNode }) {
  const t = { neutral: 'bg-surface text-muted ring-line', success: 'bg-green-50 text-success ring-green-200', warning: 'bg-amber-50 text-warning ring-amber-200', danger: 'bg-red-50 text-danger ring-red-200' }[tone];
  return <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset', t)}><span className={cx('h-1.5 w-1.5 rounded-full', DOT[tone])} aria-hidden="true" />{children}</span>;
}

/** Placeholder blocks while data loads (calmer than a blank page or a spinner). */
export function Skeleton({ className }: { className?: string }) { return <div className={cx('skeleton', className)} aria-hidden="true" />; }
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return <div role="status" aria-label="Loading" className="space-y-2">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div>;
}

/** Friendly empty state: says what this place is for and offers the next step. */
export function EmptyState({ icon = 'empty', title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card pop-in flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-tint text-accent"><Icon name={icon} size={28} /></span>
      <h2 className="text-base font-semibold">{title}</h2>{children && <p className="max-w-sm text-muted">{children}</p>}{action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto card">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line bg-tint/50 text-xs uppercase tracking-wide text-muted"><tr>{head.map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
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
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink/50 backdrop-blur-[2px] sm:items-start sm:p-4 sm:pt-24" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="max-h-[92dvh] w-full overflow-y-auto pop-in rounded-t-3xl bg-white p-5 pb-7 shadow-2xl sm:max-w-md sm:rounded-2xl sm:p-6">
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>{children}
      </div>
    </div>
  );
}
