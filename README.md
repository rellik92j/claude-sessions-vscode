# Claude Sessions

A VS Code sidebar that lists all of your Claude Code sessions, so you can browse, search, read, and resume them.

It reads the session logs Claude Code writes to `~/.claude/projects/<project>/<session-id>.jsonl` (or `$CLAUDE_CONFIG_DIR/projects`). Nothing is uploaded anywhere.

## Features

- **Sessions sidebar**: a card for each session with its title, latest prompt, time, branch, prompt count, agent and PR badges. A green pulsing dot marks sessions that were active in the last few minutes.
  - Instant search box (press `/`), with matches highlighted. Searches card details and the full conversation text (prompts and Claude's replies, not tool output); sessions matched in the transcript show the matching passage. All words must match (anywhere, case-insensitive); `"exact phrase"` matches the phrase, `-word` or `-"some phrase"` excludes sessions containing it, and `a OR b` matches either.
  - **Projects / Recent** toggle to group by project (each with its own colored avatar) or by date (Today, Yesterday, Previous 7 Days, …).
  - **Workspace** filter: show only sessions started in the folders open in this window.
  - Hover a card for quick actions: ▶ resume, open in Claude Code chat, read transcript, copy ID. Right-click for more (copy resume command, raw JSONL, PR, open project folder).
  - Keyboard: ↑/↓ to move, Enter to read the transcript, Ctrl+Enter to resume.
- **Transcript view**: a chat-style page. Your prompts are on the right, Claude's replies on the left with markdown, tables and syntax-highlighted code (with copy buttons). Each tool call is a compact row with a ✓/✗ status that expands to show its input and output, and edits show a red/green diff. Includes day separators, a toggle to hide tool calls, and a jump-to-latest button. Opened from a search, it highlights the search words and starts at the first match, with a bar to step through matches (F3 / Shift+F3, Esc to clear). The **Search Sessions…** command searches transcripts too.
  - Transcripts open in one shared preview tab that the next one you open replaces, like VS Code preview editors, so tabs don't pile up. Double-click a session (or use **Keep open** in the transcript, or *Open Transcript in New Tab* from the right-click menu) to give it its own tab.
- **Resume in Claude Code terminal**: opens the Claude Code CLI (`claude --resume <id>`) in a terminal tab beside your editor, in the session's folder, with the Claude logo, like the Claude Code extension's *Open in Terminal*. Resuming a session that is already open focuses its existing terminal.
- **Open in Claude Code Chat**: reopens the session in the Claude Code extension's chat tab.
- Everything follows your VS Code color theme (dark, light, high contrast) and auto-refreshes when session logs change.
- Agent-team sessions (named like "Project Lead") are titled with what the session worked on, and messages from other sessions show in the transcript.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeSessions.projectsDir` | `""` | Folder with session logs. Empty = `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`. |
| `claudeSessions.groupBy` | `project` | `project` or `date`. |
| `claudeSessions.currentWorkspaceOnly` | `false` | Only show sessions from the open workspace folders. |
| `claudeSessions.hideEmptySessions` | `true` | Hide sessions with no prompts or replies. |
| `claudeSessions.claudeCommand` | `claude` | Command used when resuming. |
| `claudeSessions.terminalLocation` | `editor` | `editor` (tab beside the editor) or `panel` (bottom terminal panel). |
| `claudeSessions.showThinking` | `false` | Show Claude's thinking blocks in transcripts. |
| `claudeSessions.reuseTranscriptTab` | `true` | Reuse one preview tab for transcripts; when off, every transcript gets its own tab. |

## Development

```sh
npm install
npm test          # compile + unit tests (+ a smoke test against your real ~/.claude/projects)
npm run package   # builds claude-sessions-<version>.vsix
code --install-extension claude-sessions-0.2.1.vsix
```

Press F5 in VS Code with this folder open to run the extension in a development host.
