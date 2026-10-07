// Pure parsing of GitHub Copilot CLI session logs
// (~/.copilot/session-state/<id>/events.jsonl, with workspace.yaml beside it).
// No VS Code imports here so it can be unit-tested with plain Node.

import {
  SessionInfo,
  TranscriptEntry,
  TranscriptPart,
  joinSearchText,
  oneLine,
  parseTime,
  records,
  toolHint,
  truncate,
} from './sessionParser';

type ToolUsePart = Extract<TranscriptPart, { kind: 'tool_use' }>;

/** Top-level `key: value` pairs of a simple YAML file; nested blocks, lists and comments are ignored. */
export function readYamlScalars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    let v = m[2].trim();
    if (!v || v === '|' || v === '>' || v === '~' || v === 'null') {
      continue;
    }
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    } else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
      v = v.slice(1, -1).replace(/''/g, "'");
    } else {
      v = v.replace(/\s+#.*$/, '');
    }
    if (v) {
      out[m[1]] = v;
    }
  }
  return out;
}

/** The text of a tool result, which the CLI logs as a string or as `{ content, detailedContent }`. */
function resultText(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    for (const key of ['content', 'detailedContent', 'text']) {
      if (typeof r[key] === 'string') {
        return r[key] as string;
      }
    }
    return JSON.stringify(result, null, 2);
  }
  return '';
}

function parseArgs(args: unknown): unknown {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return { arguments: args };
    }
  }
  return args ?? {};
}

function toolUse(id: unknown, name: unknown, args: unknown): ToolUsePart {
  const input = parseArgs(args) as any;
  return {
    kind: 'tool_use',
    id: typeof id === 'string' ? id : undefined,
    name: String(name ?? 'tool'),
    hint: toolHint(input),
    input: truncate(JSON.stringify(input, null, 2)),
    diff:
      typeof input?.old_str === 'string' && typeof input?.new_str === 'string'
        ? { before: truncate(input.old_str), after: truncate(input.new_str) }
        : undefined,
  };
}

/**
 * Extracts summary metadata for one Copilot CLI session. `workspaceYaml` is the session's
 * workspace.yaml, which holds its cwd, branch and generated summary.
 */
export function parseCopilotSession(text: string, filePath: string, id: string, workspaceYaml?: string): SessionInfo {
  const info: SessionInfo = {
    id,
    source: 'copilot-cli',
    key: `copilot-cli:${id}`,
    filePath,
    projectDir: '',
    title: '',
    titleSource: 'none',
    promptCount: 0,
    assistantCount: 0,
    peerMessageCount: 0,
    searchText: '',
  };
  const ws = workspaceYaml ? readYamlScalars(workspaceYaml) : {};
  const searchParts: string[] = [];

  for (const r of records(text)) {
    if (!r || typeof r !== 'object' || typeof r.type !== 'string') {
      continue;
    }
    const d = r.data && typeof r.data === 'object' ? r.data : {};
    const t = parseTime(r.timestamp);
    if (t !== undefined) {
      info.startTime = info.startTime === undefined ? t : Math.min(info.startTime, t);
      info.lastTime = info.lastTime === undefined ? t : Math.max(info.lastTime, t);
    }
    switch (r.type) {
      case 'session.start': {
        const ctx = d.context && typeof d.context === 'object' ? d.context : {};
        if (typeof ctx.cwd === 'string') {
          info.cwd ??= ctx.cwd;
        }
        if (typeof ctx.branch === 'string' && ctx.branch) {
          info.gitBranch ??= ctx.branch;
        }
        if (typeof d.copilotVersion === 'string') {
          info.version = d.copilotVersion;
        }
        if (typeof d.selectedModel === 'string') {
          info.model = d.selectedModel;
        }
        break;
      }
      case 'session.model_change':
        // "auto" is resolved per turn; the assistant messages carry the model that answered.
        if (typeof d.newModel === 'string' && d.newModel !== 'auto') {
          info.model = d.newModel;
        }
        break;
      case 'session.auto_mode_resolved':
        if (typeof d.chosenModel === 'string') {
          info.model = d.chosenModel;
        }
        break;
      case 'user.message': {
        // `content` is what was typed; `transformedContent` adds the CLI's injected context.
        const content = typeof d.content === 'string' ? d.content.trim() : '';
        if (content) {
          info.promptCount++;
          info.firstPrompt ??= content;
          info.lastPrompt = content;
          searchParts.push(content);
        }
        break;
      }
      case 'assistant.message': {
        const content = typeof d.content === 'string' ? d.content.trim() : '';
        const tools = Array.isArray(d.toolRequests) ? d.toolRequests.length : 0;
        if (content || tools) {
          info.assistantCount++;
        }
        if (content) {
          searchParts.push(content);
        }
        if (typeof d.model === 'string') {
          info.model = d.model;
        }
        break;
      }
    }
  }

  if (typeof ws.cwd === 'string') {
    info.cwd = ws.cwd;
  }
  if (ws.branch) {
    info.gitBranch = ws.branch;
  }
  info.searchText = joinSearchText(searchParts);

  // `name` is generated from the first prompt unless the user renamed the session (`user_named: true`).
  const generated = ws.name ?? ws.summary;
  if (ws.name && ws.user_named === 'true') {
    info.title = oneLine(ws.name);
    info.titleSource = 'custom';
  } else if (generated) {
    info.title = oneLine(generated);
    info.titleSource = 'ai';
  } else if (info.firstPrompt) {
    info.title = oneLine(info.firstPrompt);
    info.titleSource = 'prompt';
  } else {
    info.title = '(empty session)';
  }
  return info;
}

/** Builds a readable transcript of a Copilot CLI session. Streaming deltas and reasoning are skipped. */
export function parseCopilotTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const toolUses = new Map<string, ToolUsePart>();

  const pushAssistant = (timestamp: string | undefined, parts: TranscriptPart[]) => {
    const prev = entries[entries.length - 1];
    if (prev?.role === 'assistant') {
      prev.parts.push(...parts);
    } else {
      entries.push({ role: 'assistant', timestamp, parts });
    }
  };

  for (const r of records(text)) {
    if (!r || typeof r !== 'object' || typeof r.type !== 'string') {
      continue;
    }
    const d = r.data && typeof r.data === 'object' ? r.data : {};
    const ts = typeof r.timestamp === 'string' ? r.timestamp : undefined;
    switch (r.type) {
      case 'user.message': {
        const content = typeof d.content === 'string' ? d.content.trim() : '';
        if (content) {
          entries.push({ role: 'user', timestamp: ts, parts: [{ kind: 'text', text: content }] });
        }
        break;
      }
      case 'assistant.message': {
        const parts: TranscriptPart[] = [];
        if (typeof d.content === 'string' && d.content.trim()) {
          parts.push({ kind: 'text', text: d.content });
        }
        for (const req of Array.isArray(d.toolRequests) ? d.toolRequests : []) {
          if (!req || typeof req !== 'object') {
            continue;
          }
          const part = toolUse(req.toolCallId, req.name, req.arguments);
          if (part.id) {
            toolUses.set(part.id, part);
          }
          parts.push(part);
        }
        if (parts.length) {
          pushAssistant(ts, parts);
        }
        break;
      }
      case 'tool.execution_start': {
        // Usually announced already by the assistant message's toolRequests.
        if (typeof d.toolCallId === 'string' && toolUses.has(d.toolCallId)) {
          break;
        }
        const part = toolUse(d.toolCallId, d.toolName, d.arguments);
        if (part.id) {
          toolUses.set(part.id, part);
        }
        pushAssistant(ts, [part]);
        break;
      }
      case 'tool.execution_complete': {
        const isError = d.success === false || !!d.error;
        const errText = typeof d.error === 'string' ? d.error : typeof d.error?.message === 'string' ? d.error.message : '';
        const result = { text: truncate(resultText(d.result) || errText), isError };
        const call = typeof d.toolCallId === 'string' ? toolUses.get(d.toolCallId) : undefined;
        if (call) {
          call.result = result;
        } else {
          entries.push({ role: 'tool', timestamp: ts, parts: [{ kind: 'tool_result', ...result }] });
        }
        break;
      }
      case 'session.compaction_complete':
        entries.push({ role: 'system', timestamp: ts, parts: [{ kind: 'text', text: 'Conversation compacted' }] });
        break;
      case 'session.error':
        if (typeof d.message === 'string' && d.message.trim()) {
          entries.push({ role: 'system', timestamp: ts, parts: [{ kind: 'text', text: `Error: ${d.message}` }] });
        }
        break;
    }
  }
  return entries;
}
