import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';
import { escapeHtml } from './format';

function highlight(code: string, lang: string): string {
  const language = lang.trim().split(/\s+/)[0]?.toLowerCase();
  let body: string;
  try {
    if (language && hljs.getLanguage(language)) {
      body = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } else if (code.length < 20_000) {
      body = hljs.highlightAuto(code).value;
    } else {
      body = escapeHtml(code);
    }
  } catch {
    body = escapeHtml(code);
  }
  const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : '';
  return (
    `<div class="code-block"><div class="code-head">${label}` +
    `<button class="icon-btn copy-code" title="Copy code"><i class="codicon codicon-copy"></i></button></div>` +
    `<pre><code class="hljs">${body}</code></pre></div>`
  );
}

// html: false — raw HTML in messages is shown as text, never rendered.
const assistantMd = new MarkdownIt({ html: false, linkify: true, breaks: false, highlight });
// Prompts are typed by hand, so single newlines are meaningful.
const userMd = new MarkdownIt({ html: false, linkify: true, breaks: true, highlight });

for (const md of [assistantMd, userMd]) {
  // markdown-it wraps highlight() output in another <pre> unless it already starts with "<pre"; return ours as-is.
  md.renderer.rules.fence = (tokens, idx) => highlight(tokens[idx].content.replace(/\n$/, ''), tokens[idx].info || '');
  const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('title', tokens[idx].attrGet('href') ?? '');
    return defaultLink(tokens, idx, options, env, self);
  };
}

export function renderMarkdown(text: string, kind: 'assistant' | 'user' = 'assistant'): string {
  return (kind === 'user' ? userMd : assistantMd).render(text);
}

export function highlightCode(code: string, lang: string): string {
  return highlight(code, lang);
}
