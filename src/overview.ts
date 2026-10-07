// Totals, spend over time, projects and models across all sessions, for the overview page.
// No VS Code imports here so it can be unit-tested with plain Node.

import * as path from 'path';
import { hueFor, normalizePath } from './format';
import { SessionInfo } from './sessionParser';
import { NO_FOLDER, sessionFolder, sessionKey } from './sources';
import { dayKey } from './usage';

/** Days back from today, or 0 for all time. */
export type OverviewRange = 7 | 30 | 90 | 0;
export const OVERVIEW_RANGES: OverviewRange[] = [7, 30, 90, 0];

/** All-time spans longer than this are charted by week instead of by day. */
const MAX_DAILY_BARS = 120;
/** Sessions in each of the overview's session lists. */
const LISTED_SESSIONS = 8;

export interface OverviewBucket {
  /** First day of the bucket ("2026-10-05"). */
  start: string;
  cost: number;
  /** Sessions active on any day of the bucket. */
  sessions: number;
  /** Cost by model price key and by project key, for coloring the bar. */
  byModel: Record<string, number>;
  byProject: Record<string, number>;
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
  /** The session key. */
  id: string;
  title: string;
  project: string;
  projectKey: string;
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
  /** Keys of the projects shown, or null for all. */
  filter: string[] | null;
  /**
   * Models and project keys by all-time cost across the shown projects, highest first. Colors follow this order, so a
   * model or project keeps its color when the range changes.
   */
  series: { model: string[]; project: string[] };
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
  /** Last active first. */
  recentSessions: OverviewSession[];
  /** Most expensive first; sessions with no cost in the range are left out. */
  topSessions: OverviewSession[];
}

const sessionTime = (s: SessionInfo) => s.lastTime ?? s.startTime ?? 0;

const sessionPath = sessionFolder;

function choiceFor(p: string, lastTime: number): ProjectChoice {
  return { key: normalizePath(p), name: p ? path.basename(p) || p : NO_FOLDER, path: p, hue: hueFor(p), lastTime };
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

/** Normalized folder path of a session's project, as in `ProjectChoice.key`. */
export const projectKey = (s: SessionInfo) => normalizePath(sessionPath(s));

/** `filter` holds the keys of the projects to include (possibly none); undefined includes all. */
export function buildOverview(sessions: SessionInfo[], range: OverviewRange, now = Date.now(), filter?: string[]): Overview {
  const choices = new Map<string, ProjectChoice>();
  for (const s of sessions) {
    const c = choiceFor(sessionPath(s), sessionTime(s));
    const prev = choices.get(c.key);
    if (!prev || prev.lastTime < c.lastTime) {
      choices.set(c.key, c);
    }
  }
  if (filter) {
    // Projects picked earlier that have since gone drop out.
    filter = filter.filter((k) => choices.has(k));
    const keep = new Set(filter);
    sessions = sessions.filter((s) => keep.has(projectKey(s)));
  }

  const allTime = { model: new Map<string, number>(), project: new Map<string, number>() };
  for (const s of sessions) {
    const key = projectKey(s);
    for (const perModel of Object.values(s.usage?.daily ?? {})) {
      for (const [model, c] of Object.entries(perModel)) {
        allTime.model.set(model, (allTime.model.get(model) ?? 0) + c);
        allTime.project.set(key, (allTime.project.get(key) ?? 0) + c);
      }
    }
  }
  const byCost = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

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
      buckets.push({ start: d, cost: 0, sessions: 0, byModel: {}, byProject: {}, ids: new Set() });
    }
    bucketOf.set(d, buckets.length - 1);
  });

  const projects = new Map<string, OverviewProject>();
  const models = new Map<string, number>();
  const allDays = new Set<string>();
  const listed: OverviewSession[] = [];
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
    const key = projectKey(s);
    for (const d of inRange) {
      allDays.add(d);
      const b = buckets[bucketOf.get(d)!];
      b.ids.add(sessionKey(s));
      for (const [model, c] of Object.entries(s.usage?.daily[d] ?? {})) {
        b.cost += c;
        b.byModel[model] = (b.byModel[model] ?? 0) + c;
        b.byProject[key] = (b.byProject[key] ?? 0) + c;
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

    listed.push({ id: sessionKey(s), title: s.title, project: proj.name, projectKey: proj.key, hue: proj.hue, prompts: s.promptCount, cost: sCost, lastTime: sessionTime(s) });
  }

  return {
    range,
    filter: filter ?? null,
    series: { model: byCost(allTime.model), project: byCost(allTime.project) },
    allProjects: [...choices.values()].sort((a, b) => b.lastTime - a.lastTime),
    from,
    to,
    totals: { sessions: sessionCount, prompts, cost, projects: projects.size, activeDays: allDays.size },
    bucketDays,
    buckets: buckets.map(({ ids, ...b }) => ({ ...b, sessions: ids.size })),
    projects: [...projects.values()].sort((a, b) => b.cost - a.cost || b.lastTime - a.lastTime),
    models: [...models.entries()].map(([model, c]) => ({ model, cost: c })).sort((a, b) => b.cost - a.cost),
    recentSessions: [...listed].sort((a, b) => b.lastTime - a.lastTime).slice(0, LISTED_SESSIONS),
    topSessions: listed.filter((s) => s.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, LISTED_SESSIONS),
  };
}
