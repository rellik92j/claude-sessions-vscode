# Claude Sessions

**Find, read and pick up any Claude Code session without leaving VS Code.**

[Claude Code](https://claude.com/claude-code) saves every conversation you have with it, but finding an old one means scrolling through `claude --resume` and guessing from the first line. Claude Sessions adds a sidebar that shows all of your sessions across every project. You can search everything you and Claude said, read any conversation as a chat transcript, and resume it in one click.

![The Claude Sessions sidebar next to a transcript](docs/images/overview.png)

## What you can do with it

### Browse every session in one place

The sidebar shows a card for each session with its title, your latest prompt, when it happened, the git branch, how many prompts it has, and badges for subagents and pull requests. A pulsing green dot marks sessions that were active in the last few minutes.

Each card also shows what the session cost at Claude API prices. Two more badges appear only when they're useful: how full the context window is once it passes 50%, and a countdown while the prompt cache is still warm, when resuming is cheapest.

- **Projects** groups sessions by folder, and each project gets its own colored avatar. **Recent** groups them by date (Today, Yesterday, Previous 7 Days, and so on).
- **Workspace** filter: show only the sessions started in the folders you have open in this window.
- Hover a card for quick actions: resume, continue in a new session, open in Claude Code chat, read the transcript, or copy the session ID. Right-click for more.

### Search everything you and Claude said

![Searching sessions, with the matching passage shown under each card](docs/images/search.png)

Press `/` to search. The search covers the card details and the full conversation: your prompts and Claude's replies, but not tool output. When a session matches inside its conversation, its card shows the matching passage.

| Type | To find |
| --- | --- |
| `auth bug` | sessions containing both words, anywhere, in any case |
| `"race condition"` | the exact phrase |
| `-flaky` or `-"some phrase"` | sessions that *don't* contain it |
| `redis OR postgres` | sessions containing either word |

### Read a session as a chat

![A transcript with markdown, a code block and an expanded edit diff](docs/images/transcript.png)

Click a session to open its transcript. Your prompts are on the right and Claude's replies are on the left, with markdown, tables and syntax-highlighted code that you can copy.

- Above the conversation, usage stats like those in Claude Code's status line: how full the context window is, whether the prompt cache is still warm and for how long, the token counts, and the cost at Claude API prices, subagents included. Expand **Cost breakdown** to see the cost of each token type. On a Pro or Max plan you aren't billed per token, so the cost shows what the session would cost through the API.
- Each tool call is a compact row with a ✓ or ✗. Click it to see the input and output. File edits show as a red/green diff.
- Hide tool calls to read just the conversation, or jump straight to the latest message.
- If you opened the transcript from a search, your search words are highlighted and it starts at the first match. Step through matches with F3 / Shift+F3.
- Transcripts open in a single preview tab that the next one replaces, so tabs don't pile up. Double-click a session, or click **Keep open**, to give it a tab of its own.

### Pick up where you left off

![Resuming a session in a Claude Code terminal beside the editor](docs/images/resume.png)

- **Resume** (▶) opens `claude --resume <id>` in a terminal tab beside your editor, in the session's project folder. If the session is already open, its terminal is focused instead.
- **Continue in New Session** (⮕) starts a fresh session with a handoff of where the old one stopped. The handoff includes your last request, Claude's last reply, the files it edited and read, any open to-dos, the current `git status`, and the path to the old transcript. Claude is asked to summarize and wait for your instruction before changing anything. Use this when a session has grown too long to keep working in. To use a different model or effort level than your Claude Code settings, choose **Continue in New Session with Model…** from the right-click menu, or the ⌄ button next to **Continue in new session** in a transcript.
- **Open in Claude Code Chat** reopens the session in the chat panel of the official Claude Code extension, if you have it installed.

The sidebar refreshes on its own as sessions change, and everything follows your VS Code color theme.

## Install

You need **VS Code 1.90 or newer**. To use Resume and Continue in New Session, you also need the **[Claude Code CLI](https://docs.claude.com/en/docs/claude-code/setup)** installed, so that `claude` runs in a terminal.

Claude Sessions isn't on the VS Code Marketplace yet. To install it:

1. Download the latest `claude-sessions-<version>.vsix` from the [Releases page](https://github.com/rellik92j/claude-sessions-vscode/releases/latest).
2. In VS Code, open the Extensions view, click the `…` menu at the top, and choose **Install from VSIX…**. Then pick the file you downloaded.

   Or, from a terminal:

   ```sh
   code --install-extension claude-sessions-0.2.5.vsix
   ```

3. Click the **Claude Sessions** icon in the Activity Bar.

To update, install the newer `.vsix` the same way.

## Privacy

Claude Sessions only reads the session logs that Claude Code already keeps on your machine, in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects` if you set it). It sends nothing over the network, and it never changes or deletes your logs.

## Keyboard shortcuts

In the sidebar:

| Key | Action |
| --- | --- |
| `/` | Focus search |
| ↑ / ↓ | Move between sessions |
| Enter | Open transcript |
| Ctrl+Enter | Resume |

In a transcript: F3 / Shift+F3 step through search matches, and Esc clears them.

The **Claude Sessions: Search Sessions…** command in the Command Palette searches transcripts too.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeSessions.projectsDir` | `""` | Folder with session logs. Empty means `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`. |
| `claudeSessions.groupBy` | `project` | Group sessions by `project` or `date`. |
| `claudeSessions.currentWorkspaceOnly` | `false` | Only show sessions from the open workspace folders. |
| `claudeSessions.hideEmptySessions` | `true` | Hide sessions with no prompts or replies. |
| `claudeSessions.claudeCommand` | `claude` | Command used to launch Claude Code when resuming. |
| `claudeSessions.terminalLocation` | `editor` | Open the terminal as an `editor` tab or in the bottom `panel`. |
| `claudeSessions.showThinking` | `false` | Show Claude's thinking blocks in transcripts. |
| `claudeSessions.reuseTranscriptTab` | `true` | Reuse one preview tab for transcripts. When off, every transcript gets its own tab. |

## Development

```sh
npm install
npm test          # compile, bundle and run unit tests (plus a smoke test against your real ~/.claude/projects)
npm run package   # build claude-sessions-<version>.vsix
```

Press F5 with this folder open to run the extension in a development host.

## License

[MIT](LICENSE)
