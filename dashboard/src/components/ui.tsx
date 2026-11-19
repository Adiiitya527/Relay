import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { formatHash, type Route } from '../lib/router.js';
import { absoluteTime, errorMessage, relativeTime } from '../lib/format.js';

// Small presentational pieces. Everything user- or consumer-controlled (URLs, payloads,
// response excerpts) is rendered as React text children, which React escapes; nothing in
// the dashboard uses dangerouslySetInnerHTML.

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-300',
  good: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  warn: 'bg-amber-50 text-amber-800 ring-amber-300',
  bad: 'bg-rose-50 text-rose-800 ring-rose-300',
  info: 'bg-sky-50 text-sky-800 ring-sky-300',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      {children}
    </span>
  );
}

type Variant = 'primary' | 'secondary' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700',
  secondary: 'bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50',
  danger: 'bg-rose-600 text-white hover:bg-rose-500',
};

export function Button({ variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Link({ to, children, className = '' }: { to: Route; children: ReactNode; className?: string }) {
  return (
    <a href={formatHash(to)} className={`text-sky-700 hover:underline ${className}`}>
      {children}
    </a>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
      {errorMessage(error)}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{children}</div>;
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <div className="flex gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-slate-500">{children}</p>;
}

export function Loading() {
  return <p className="py-6 text-center text-sm text-slate-500">Loading…</p>;
}

export function Time({ iso, now }: { iso: string | null; now: number }) {
  if (!iso) return <span className="text-slate-400">—</span>;
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso, now)}
    </time>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="font-mono text-xs" title={title}>
      {children}
    </span>
  );
}

export function Th({ children }: { children?: ReactNode }) {
  return <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500">{children}</th>;
}

export function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top text-sm ${className}`}>{children}</td>;
}
