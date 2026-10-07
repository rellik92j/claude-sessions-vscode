// The tools whose sessions the extension lists, and what differs between them.
// No VS Code imports here so it can be unit-tested with plain Node.

import { decodeProjectDir, SessionInfo } from './sessionParser';

export type SessionSource = 'claude' | 'copilot-cli' | 'vscode-chat';

export const SOURCE_IDS: SessionSource[] = ['claude', 'copilot-cli', 'vscode-chat'];

export interface SourceInfo {
  id: SessionSource;
  /** Full name, for settings, menus and tooltips. */
  label: string;
  /** Chip and badge text. */
  short: string;
  /** Codicon name. */
  icon: string;
  /** Who replies in the transcript. */
  assistant: string;
  /** The primary action's button text and tooltip. */
  resumeLabel: string;
  resumeTitle: string;
}

export const SOURCES: Record<SessionSource, SourceInfo> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    short: 'Claude',
    icon: 'sparkle',
    assistant: 'Claude',
    resumeLabel: 'Resume',
    resumeTitle: 'Resume this session with the Claude Code CLI',
  },
  'copilot-cli': {
    id: 'copilot-cli',
    label: 'GitHub Copilot CLI',
    short: 'Copilot CLI',
    icon: 'copilot',
    assistant: 'Copilot',
    resumeLabel: 'Resume',
    resumeTitle: 'Resume this session with the GitHub Copilot CLI',
  },
  'vscode-chat': {
    id: 'vscode-chat',
    label: 'VS Code Chat',
    short: 'VS Code Chat',
    icon: 'chat-sparkle',
    assistant: 'Copilot',
    resumeLabel: 'Open in Chat',
    resumeTitle: 'Open this conversation in VS Code Chat',
  },
};

/** Group label for sessions with no known folder (VS Code chats in an empty window, for example). */
export const NO_FOLDER = 'No folder';

/** A session's source; sessions without one are Claude Code's. */
export const sourceOf = (s: SessionInfo): SessionSource => (s as { source?: SessionSource }).source ?? 'claude';

/** Identifies a session across sources, whose ids may collide. */
export const sessionKey = (s: SessionInfo): string => (s as { key?: string }).key ?? `${sourceOf(s)}:${s.id}`;

export const isClaude = (s: SessionInfo) => sourceOf(s) === 'claude';

/** The folder a session was started in; '' when unknown (only possible outside Claude Code). */
export function sessionFolder(s: SessionInfo): string {
  return s.cwd ?? (isClaude(s) && s.projectDir ? decodeProjectDir(s.projectDir) : '');
}

export const isSource = (v: unknown): v is SessionSource => typeof v === 'string' && (SOURCE_IDS as string[]).includes(v);

/** A sources setting or message as a list of known sources; anything that isn't an array means all of them. */
export function toSources(value: unknown): SessionSource[] {
  return Array.isArray(value) ? SOURCE_IDS.filter((id) => value.includes(id)) : [...SOURCE_IDS];
}

/** Names accepted after `source:` in a search. */
const ALIASES: Record<string, SessionSource> = {
  claude: 'claude',
  'claude-code': 'claude',
  copilot: 'copilot-cli',
  cli: 'copilot-cli',
  'copilot-cli': 'copilot-cli',
  chat: 'vscode-chat',
  vscode: 'vscode-chat',
  'vscode-chat': 'vscode-chat',
};

export const sourceAlias = (name: string): SessionSource | undefined => ALIASES[name.toLowerCase()];
