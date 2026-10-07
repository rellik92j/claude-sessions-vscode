// Pure parsing of VS Code Chat sessions
// (<User>/workspaceStorage/<hash>/chatSessions/<id>.json or .jsonl).
// No VS Code imports here so it can be unit-tested with plain Node.

import {
  SessionInfo,
  TranscriptEntry,
  TranscriptPart,
  joinSearchText,
  oneLine,
  records,
  toolHint,
  truncate,
} from './sessionParser';

type ToolUsePart = Extract<TranscriptPart, { kind: 'tool_use' }>;

/** A file link's path for display: file:///c%3A/repo/a.ts -> c:/repo/a.ts. */
function linkPath(uri: string): string {
  try {
    const u = new URL(uri);
    return u.protocol === 'file:' ? decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1') : uri;
  } catch {
    return uri;
  }
}

/** A tool message as plain text: VS Code writes file links with empty text ("Read [](file:///…)"), shown as the path. */
function plainMessage(text: string): string {
  return text.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, label: string, uri: string) => label || linkPath(uri));
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The container at `path` inside `root`, creating objects/arrays along the way when missing. */
function walk(root: Record<string, any>, path: unknown[]): any {
  let cur: any = root;
  for (let i = 0; i < path.length; i++) {
    const key = path[i] as string | number;
    if (cur === null || typeof cur !== 'object') {
      return undefined;
    }
    if (cur[key] === null || typeof cur[key] !== 'object') {
      cur[key] = typeof path[i + 1] === 'number' ? [] : {};
    }
    cur = cur[key];
  }
  return cur;
}

/**
 * Rebuilds a chat session object. Legacy `.json` files hold the whole object; `.jsonl` files are a
 * patch log: kind 0 is a snapshot, kind 1 sets the value at path `k`, kind 2 appends `v` to the
 * array at `k` (first cutting it back to index `i` when given), kind 3 deletes `k`. Truncated
 * lines and unknown kinds are skipped, and a missing snapshot starts from an empty object.
 */
export function rebuildChatSession(text: string): Record<string, any> {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const whole = JSON.parse(trimmed);
      if (isObject(whole) && typeof whole.kind !== 'number') {
        return whole;
      }
    } catch {
      // Not a single JSON document; read it as a patch log.
    }
  }

  let state: Record<string, any> = {};
  for (const r of records(text)) {
    if (!isObject(r)) {
      continue;
    }
    const path = Array.isArray(r.k) ? r.k.filter((p: unknown) => typeof p === 'string' || typeof p === 'number') : [];
    switch (r.kind) {
      case 0:
        if (isObject(r.v)) {
          state = r.v;
        }
        break;
      case 1: {
        if (!path.length) {
          if (isObject(r.v)) {
            state = r.v;
          }
          break;
        }
        const parent = walk(state, path.slice(0, -1));
        if (parent && typeof parent === 'object') {
          parent[path[path.length - 1]] = r.v;
        }
        break;
      }
      case 2: {
        const parent = walk(state, path.slice(0, -1));
        if (!parent || typeof parent !== 'object') {
          break;
        }
        const last = path[path.length - 1];
        let arr = path.length ? parent[last] : undefined;
        if (!Array.isArray(arr)) {
          if (!path.length) {
            break;
          }
          arr = parent[last] = [];
        }
        const items = Array.isArray(r.v) ? r.v : r.v === undefined ? [] : [r.v];
        if (typeof r.i === 'number' && r.i >= 0 && r.i <= arr.length) {
          arr.splice(r.i, arr.length - r.i, ...items);
        } else {
          arr.push(...items);
        }
        break;
      }
      case 3: {
        if (!path.length) {
          break;
        }
        const parent = walk(state, path.slice(0, -1));
        const last = path[path.length - 1];
        if (Array.isArray(parent) && typeof last === 'number') {
          if (last >= 0) {
            parent.splice(last, 1);
          }
        } else if (parent && typeof parent === 'object') {
          delete parent[last];
        }
        break;
      }
    }
  }
  return state;
}

/** Plain text of a markdown-ish value: a string, `{ value }`, or `{ content: { value } }`. */
function md(v: unknown): string {
  if (typeof v === 'string') {
    return v;
  }
  if (isObject(v)) {
    if (typeof v.value === 'string') {
      return v.value;
    }
    if (isObject(v.content) || typeof v.content === 'string') {
      return md(v.content);
    }
  }
  return '';
}

function requestsOf(session: Record<string, any>): Record<string, any>[] {
  return Array.isArray(session.requests) ? session.requests.filter((r) => isObject(r) && r.hiddenFromTranscript !== true) : [];
}

/** The model that answered: set directly on older requests, resolved later for "Auto". */
function modelOf(req: Record<string, any>): string | undefined {
  if (typeof req.modelId === 'string' && req.modelId) {
    return req.modelId;
  }
  const resolved = req.result?.metadata?.resolvedModel;
  if (typeof resolved === 'string' && resolved) {
    return resolved;
  }
  for (const p of Array.isArray(req.response) ? req.response : []) {
    if (p?.kind === 'autoModeResolution' && typeof p.resolved?.id === 'string') {
      return p.resolved.id;
    }
  }
  return undefined;
}

function promptOf(req: Record<string, any>): string {
  const m = req.message;
  return (typeof m === 'string' ? m : typeof m?.text === 'string' ? m.text : '').trim();
}

function inlineRefName(part: Record<string, any>): string {
  const ref = part.inlineReference;
  if (typeof part.name === 'string' && part.name) {
    return part.name;
  }
  if (isObject(ref)) {
    if (typeof ref.name === 'string') {
      return ref.name;
    }
    const p = typeof ref.path === 'string' ? ref.path : typeof ref.uri?.path === 'string' ? ref.uri.path : '';
    return p.split('/').pop() ?? '';
  }
  return '';
}

function toolPart(part: Record<string, any>): ToolUsePart {
  const details = isObject(part.resultDetails) ? part.resultDetails : undefined;
  const rawInput = details?.input ?? part.toolSpecificData;
  let input: unknown = rawInput;
  if (typeof rawInput === 'string') {
    try {
      input = JSON.parse(rawInput);
    } catch {
      input = rawInput;
    }
  }
  const message = md(part.pastTenseMessage) || md(part.invocationMessage);
  let result: ToolUsePart['result'];
  if (details && Array.isArray(details.output)) {
    const text = details.output.map((o: unknown) => md(o) || (isObject(o) && o.type !== 'embed' ? JSON.stringify(o) : '')).join('\n');
    result = { text: truncate(text), isError: !!details.isError };
  } else if (details && (details.isError || typeof details.output === 'string')) {
    result = { text: truncate(md(details.output)), isError: !!details.isError };
  } else if (part.isComplete === true) {
    // VS Code keeps the output of only some tools; a completed call without it still succeeded.
    result = { text: 'VS Code Chat did not save this tool call\'s output.', isError: false };
  }
  return {
    kind: 'tool_use',
    id: typeof part.toolCallId === 'string' ? part.toolCallId : undefined,
    name: String(part.toolId ?? 'tool'),
    hint: message ? oneLine(plainMessage(message), 140) : toolHint(input),
    input: truncate(typeof input === 'string' ? input : JSON.stringify(input ?? {}, null, 2)),
    result,
  };
}

/** Transcript parts of one response; consecutive markdown pieces and inline references are joined. */
function responseParts(req: Record<string, any>): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  let text = '';
  const flush = () => {
    if (text.trim()) {
      parts.push({ kind: 'text', text });
    }
    text = '';
  };
  for (const p of Array.isArray(req.response) ? req.response : []) {
    if (!isObject(p)) {
      continue;
    }
    switch (p.kind) {
      case undefined:
      case 'markdownContent':
      case 'markdownVuln':
        text += md(p);
        break;
      case 'inlineReference': {
        const name = inlineRefName(p);
        text += name ? `\`${name}\`` : '';
        break;
      }
      case 'thinking': {
        const t = Array.isArray(p.value) ? p.value.map(md).join('') : md(p);
        if (t.trim()) {
          flush();
          parts.push({ kind: 'thinking', text: t });
        }
        break;
      }
      case 'toolInvocationSerialized':
      case 'toolInvocation':
        flush();
        parts.push(toolPart(p));
        break;
      case 'warning':
        flush();
        if (md(p.content)) {
          parts.push({ kind: 'text', text: `> ⚠ ${md(p.content)}` });
        }
        break;
    }
  }
  flush();
  return parts;
}

/** The error a failed or canceled request ended with, shown after its response. */
function errorPart(req: Record<string, any>): TranscriptPart | undefined {
  const err = req.result?.errorDetails?.message;
  return typeof err === 'string' && err.trim() ? { kind: 'text', text: `> Error: ${err}` } : undefined;
}

function numericTime(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v;
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** Extracts summary metadata for one VS Code Chat session. `cwd` is the workspace folder, if known. */
export function parseChatSession(text: string, filePath: string, id: string, cwd?: string): SessionInfo {
  const session = rebuildChatSession(text);
  const info: SessionInfo = {
    id,
    source: 'vscode-chat',
    key: `vscode-chat:${id}`,
    filePath,
    projectDir: '',
    cwd,
    title: '',
    titleSource: 'none',
    promptCount: 0,
    assistantCount: 0,
    peerMessageCount: 0,
    searchText: '',
  };
  const searchParts: string[] = [];
  const times: number[] = [];
  for (const v of [session.creationDate, session.lastMessageDate]) {
    const t = numericTime(v);
    if (t !== undefined) {
      times.push(t);
    }
  }

  for (const req of requestsOf(session)) {
    const prompt = promptOf(req);
    if (prompt) {
      info.promptCount++;
      info.firstPrompt ??= prompt;
      info.lastPrompt = prompt;
      searchParts.push(prompt);
    }
    const parts = responseParts(req);
    if (parts.some((p) => p.kind === 'text' || p.kind === 'tool_use')) {
      info.assistantCount++;
    }
    for (const p of parts) {
      if (p.kind === 'text') {
        searchParts.push(p.text);
      }
    }
    const t = numericTime(req.timestamp);
    if (t !== undefined) {
      times.push(t);
      const elapsed = req.result?.timings?.totalElapsed;
      if (typeof elapsed === 'number' && elapsed > 0) {
        times.push(t + elapsed);
      }
    }
    for (const v of [req.responseTimestamp, req.modelState?.completedAt]) {
      const done = numericTime(v);
      if (done !== undefined) {
        times.push(done);
      }
    }
    info.model = modelOf(req) ?? info.model;
  }
  if (times.length) {
    info.startTime = Math.min(...times);
    info.lastTime = Math.max(...times);
  }
  info.searchText = joinSearchText(searchParts);

  if (typeof session.customTitle === 'string' && session.customTitle.trim()) {
    info.title = oneLine(session.customTitle);
    info.titleSource = 'custom';
  } else if (info.firstPrompt) {
    info.title = oneLine(info.firstPrompt);
    info.titleSource = 'prompt';
  } else {
    info.title = '(empty session)';
  }
  return info;
}

/** Builds a readable transcript of a VS Code Chat session: one user and one assistant turn per request. */
export function parseChatTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const req of requestsOf(rebuildChatSession(text))) {
    const t = numericTime(req.timestamp);
    const timestamp = t !== undefined ? new Date(t).toISOString() : undefined;
    const prompt = promptOf(req);
    if (prompt) {
      entries.push({ role: 'user', timestamp, parts: [{ kind: 'text', text: prompt }] });
    }
    const parts = responseParts(req);
    const err = errorPart(req);
    if (err) {
      parts.push(err);
    }
    if (parts.length) {
      entries.push({ role: 'assistant', timestamp, parts });
    }
  }
  return entries;
}
