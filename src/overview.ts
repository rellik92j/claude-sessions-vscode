// Totals, spend over time, projects and models across all sessions, for the overview page.
// No VS Code imports here so it can be unit-tested with plain Node.

import * as path from 'path';
import { hueFor, normalizePath } from './format';
import { decodeProjectDir, SessionInfo } from './sessionParser';
import { dayKey } from './usage';

/** Days back from today, or 0 for all time. */
export type OverviewRange = 7 | 30 | 90 | 0;
export const OVERVIEW_RANGES: OverviewRange[] = [7, 30, 90, 0];

/** All-time spans longer than this are charted by week instead of by day. */
const MAX_DAILY_BARS = 120;
const TOP_SESSIONS = 8;

export interface OverviewBucket {
  /** First day of the bucket ("2026-10-05"). */
  start: string;
  cost: number;
  /** Sessions active on any day of the bucket. */
  sessions: number;
}

export interface OverviewProject {
  /** Normalized folder path; what the project filter holds. */
  key: string;
  name: string;
  path: string;
  hue: number;
  sessions: number;
  prompts: number;
  cost: number;
  lastTime: number;
}

export interface OverviewSession {
  id: string;
  title: string;
  project: string;
  hue: number;
  prompts: number;
  cost: number;
  lastTime: number;
}

/** A project the filter can pick, whether or not it has sessions in the range. */
export interface ProjectChoice {
  key: string;
  name: string;
  path: string;
  hue: number;
  lastTime: number;
}

export interface Overview {
  range: OverviewRange;
  /** Keys of the projects shown; empty for all. */
  filter: string[];
  /** Every project, most recently active first. */
  allProjects: ProjectChoice[];
  /** First and last day covered. */
  from: string;
  to: string;
  totals: { sessions: number; prompts: number; cost: number; projects: number; activeDays: number };
  /** Days per chart bar: 1, or 7 for long all-time spans. */
  bucketDays: number;
  buckets: OverviewBucket[];
  /** Most expensive first. */
  projects: OverviewProject[];
  models: { model: string; cost: number }[];
  topSessions: OverviewSession[];
}

const sessionTime = (s: SessionInfo) => s.lastTime ?? s.startTime ?? 0;

const sessionPath = (s: SessionInfo) => s.cwd ?? decodeProjectDir(s.projectDir);

function choiceFor(p: string, lastTime: number): ProjectChoice {
  return { key: normalizePath(p), name: path.basename(p) || p, path: p, hue: hueFor(p), lastTime };
}

/** Days a session did anything: days it made API requests, and the day of its last message. */
function activeDays(s: SessionInfo): Set<string> {
  const days = new Set(Object.keys(s.usage?.daily ?? {}));
  const t = sessionTime(s);
  if (t) {
    days.add(dayKey(t));
  }
  return days;
}

function startOfDay(time: number, daysBack = 0): Date {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d;
}

/** Day keys from `from` to `to`, inclusive. */
function daysBetween(from: string, to: string): string[] {
  const [y, m, d] = from.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  const out: string[] = [];
  for (let k = dayKey(day.getTime()); k <= to; day.setDate(day.getDate() + 1), k = dayKey(day.getTime())) {
    out.push(k);
  }
  return out;
}

/** `filter` holds the keys of the projects to include; empty includes all. */
export function buildOverview(sessions: SessionInfo[], range: OverviewRange, now = Date.now(), filter: string[] = []): Overview {
  const choices = new Map<string, ProjectChoice>();
  for (const s of sessions) {
    const c = choiceFor(sessionPath(s), sessionTime(s));
    const prev = choices.get(c.key);
    if (!prev || prev.lastTime < c.lastTime) {
      choices.set(c.key, c);
    }
  }
  // A project picked earlier that has since gone (or is hidden by the workspace filter) no longer filters anything.
  filter = filter.filter((k) => choices.has(k));
  if (filter.length) {
    const keep = new Set(filter);
    sessions = sessions.filter((s) => keep.has(normalizePath(sessionPath(s))));
  }

  const to = dayKey(now);
  const activity = sessions.map((s) => ({ s, days: activeDays(s) }));
  let from = range ? dayKey(startOfDay(now, range - 1).getTime()) : to;
  if (!range) {
    for (const { days } of activity) {
      for (const d of days) {
        if (d < from) {
          from = d;
        }
      }
    }
  }

  const days = daysBetween(from, to);
  const bucketDays = days.length > MAX_DAILY_BARS ? 7 : 1;
  const buckets: (OverviewBucket & { ids: Set<string> })[] = [];
  const bucketOf = new Map<string, number>();
  days.forEach((d, i) => {
    if (i % bucketDays === 0) {
      buckets.push({ start: d, cost: 0, sessions: 0, ids: new Set() });
    }
    bucketOf.set(d, buckets.length - 1);
  });

  const projects = new Map<string, OverviewProject>();
  const models = new Map<string, number>();
  const allDays = new Set<string>();
  const top: OverviewSession[] = [];
  let sessionCount = 0;
  let prompts = 0;
  let cost = 0;

  for (const { s, days: sDays } of activity) {
    const inRange = [...sDays].filter((d) => d >= from && d <= to);
    if (!inRange.length) {
      continue;
    }
    sessionCount++;
    prompts += s.promptCount;
    let sCost = 0;
    for (const d of inRange) {
      allDays.add(d);
      const b = buckets[bucketOf.get(d)!];
      b.ids.add(s.id);
      for (const [model, c] of Object.entries(s.usage?.daily[d] ?? {})) {
        b.cost += c;
        sCost += c;
        models.set(model, (models.get(model) ?? 0) + c);
      }
    }
    cost += sCost;

    const c = choiceFor(sessionPath(s), 0);
    let proj = projects.get(c.key);
    if (!proj) {
      proj = { ...c, sessions: 0, prompts: 0, cost: 0 };
      projects.set(c.key, proj);
    }
    proj.sessions++;
    proj.prompts += s.promptCount;
    proj.cost += sCost;
    proj.lastTime = Math.max(proj.lastTime, sessionTime(s));

    if (sCost > 0) {
      top.push({ id: s.id, title: s.title, project: proj.name, hue: proj.hue, prompts: s.promptCount, cost: sCost, lastTime: sessionTime(s) });
    }
  }

  return {
    range,
    filter,
    allProjects: [...choices.values()].sort((a, b) => b.lastTime - a.lastTime),
    from,
    to,
    totals: { sessions: sessionCount, prompts, cost, projects: projects.size, activeDays: allDays.size },
    bucketDays,
    buckets: buckets.map(({ ids, ...b }) => ({ ...b, sessions: ids.size })),
    projects: [...projects.values()].sort((a, b) => b.cost - a.cost || b.lastTime - a.lastTime),
    models: [...models.entries()].map(([model, c]) => ({ model, cost: c })).sort((a, b) => b.cost - a.cost),
    topSessions: top.sort((a, b) => b.cost - a.cost).slice(0, TOP_SESSIONS),
  };
}
