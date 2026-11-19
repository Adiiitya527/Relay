import { ApiError } from './api.js';

/** "12 s ago", "in 3 min", for timestamps relative to `now` (epoch ms). */
export function relativeTime(iso: string, now: number): string {
  const diffMs = new Date(iso).getTime() - now;
  if (!Number.isFinite(diffMs)) return '—';
  const abs = Math.abs(diffMs);
  if (abs < 1_000) return 'now';
  let text: string;
  if (abs < 60_000) text = `${Math.round(abs / 1000)} s`;
  else if (abs < 3_600_000) text = `${Math.round(abs / 60_000)} min`;
  else if (abs < 86_400_000) text = `${Math.round(abs / 3_600_000)} h`;
  else text = `${Math.round(abs / 86_400_000)} d`;
  return diffMs > 0 ? `in ${text}` : `${text} ago`;
}

/** Exact local time for tooltips. */
export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** First 8 characters of a uuid, for compact tables (the full id is in the title). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** A message for the user from anything a request can throw. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.status === 0 || err.code === 'http_error' ? err.message : `${err.message} (${err.code})`;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
