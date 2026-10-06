// Small pure helpers shared by the tree and the transcript view.

export function formatRelative(time: number, now = Date.now()): string {
  const sec = Math.round((now - time) / 1000);
  if (sec < 45) {
    return 'just now';
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.round(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  const day = Math.round(hr / 24);
  if (day < 30) {
    return `${day}d ago`;
  }
  const d = new Date(time);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(time: number | undefined): string {
  if (time === undefined) {
    return 'unknown';
  }
  return new Date(time).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export type DateBucket = 'Today' | 'Yesterday' | 'Previous 7 Days' | 'Previous 30 Days' | 'Older';
export const DATE_BUCKETS: DateBucket[] = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];

export function dateBucket(time: number, now = Date.now()): DateBucket {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (time >= today) {
    return 'Today';
  }
  if (time >= today - dayMs) {
    return 'Yesterday';
  }
  if (time >= today - 7 * dayMs) {
    return 'Previous 7 Days';
  }
  if (time >= today - 30 * dayMs) {
    return 'Previous 30 Days';
  }
  return 'Older';
}

/** Normalizes a path for comparisons (case-insensitive and slash-agnostic on Windows). */
export function normalizePath(p: string, platform: NodeJS.Platform = process.platform): string {
  let out = p.replace(/[\\/]+$/, '');
  if (platform === 'win32') {
    out = out.replace(/\//g, '\\').toLowerCase();
  }
  return out;
}

export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const c = normalizePath(child, platform);
  const p = normalizePath(parent, platform);
  const sep = platform === 'win32' ? '\\' : '/';
  return c === p || c.startsWith(p + sep);
}

/** A stable hue (0–359) for a project folder, so the project keeps its color in every view. */
export function hueFor(text: string): number {
  let h = 0;
  for (const ch of normalizePath(text)) {
    h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return h % 360;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  }
  return `${+(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}
