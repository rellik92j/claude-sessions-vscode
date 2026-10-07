// Reads any session's log as transcript entries, with the parser for its source.
// No VS Code imports here so it can be unit-tested with plain Node.

import { parseCopilotTranscript } from './copilotCliParser';
import { parseTranscript, SessionInfo, TranscriptEntry } from './sessionParser';
import { sourceOf } from './sources';
import { parseChatTranscript } from './vscodeChatParser';

export function parseTranscriptFor(session: SessionInfo, text: string): TranscriptEntry[] {
  switch (sourceOf(session)) {
    case 'copilot-cli':
      return parseCopilotTranscript(text);
    case 'vscode-chat':
      return parseChatTranscript(text);
    default:
      return parseTranscript(text);
  }
}
