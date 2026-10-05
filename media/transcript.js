// Transcript page interactions: header actions, copy buttons, tool toggle, jump-to-latest.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

  document.addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-cmd]');
    if (cmd) {
      vscode.postMessage({ command: cmd.dataset.cmd });
      return;
    }
    const copy = e.target.closest('.copy-code');
    if (copy) {
      const code = copy.closest('.code-block')?.querySelector('code')?.innerText ?? '';
      vscode.postMessage({ command: 'copyText', text: code });
      const icon = copy.querySelector('.codicon');
      icon.classList.replace('codicon-copy', 'codicon-check');
      setTimeout(() => icon.classList.replace('codicon-check', 'codicon-copy'), 1200);
    }
  });

  const toggle = document.getElementById('show-tools');
  const applyTools = () => document.body.classList.toggle('hide-tools', !!toggle && !toggle.checked);
  if (toggle) {
    toggle.checked = saved.showTools !== false;
    toggle.addEventListener('change', () => {
      vscode.setState({ ...saved, showTools: toggle.checked });
      saved.showTools = toggle.checked;
      applyTools();
    });
    applyTools();
  }

  // Compact top bar gets a shadow once the hero scrolls away; the jump button shows when far from the bottom.
  const jump = document.getElementById('jump');
  const onScroll = () => {
    const y = window.scrollY;
    document.body.classList.toggle('scrolled', y > 8);
    const fromBottom = document.documentElement.scrollHeight - (y + window.innerHeight);
    jump.classList.toggle('visible', fromBottom > 600);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  jump.addEventListener('click', () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));

  // ---------- search highlights (when opened from a search) ----------

  let highlight = [];
  try {
    highlight = JSON.parse(document.body.dataset.highlight || '[]');
  } catch {
    // Malformed attribute; open without highlights.
  }

  /** Wraps every occurrence of the search words in message text (not tool calls or thinking) in <mark class="hit">. */
  function markHits(words) {
    // Spaces in a phrase match any whitespace. A phrase split by formatting (e.g. "dark **mode**") isn't marked.
    const pattern = (w) => w.split(' ').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const re = new RegExp(words.map(pattern).join('|'), 'gi');
    const root = document.querySelector('.conversation');
    if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement.closest('.md') && !n.parentElement.closest('details.tool, details.thinking, .code-head')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const marks = [];
    for (const node of nodes) {
      const text = node.nodeValue;
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (let m; (m = re.exec(text)); ) {
        if (!m[0]) break;
        frag.append(text.slice(last, m.index));
        const mark = document.createElement('mark');
        mark.className = 'hit';
        mark.textContent = m[0];
        frag.append(mark);
        marks.push(mark);
        last = m.index + m[0].length;
      }
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
    return marks;
  }

  const hits = highlight.length ? markHits(highlight) : [];
  let current = -1;

  /** Floating bar with the match count and previous/next/close buttons. */
  function buildFindBar() {
    const bar = document.createElement('div');
    bar.className = 'findbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Search matches');
    bar.innerHTML = `
      <i class="codicon codicon-search"></i>
      <span class="find-query"></span>
      <span class="find-count" aria-live="polite"></span>
      <button class="icon-btn" data-find="prev" title="Previous match (Shift+F3)" aria-label="Previous match"><i class="codicon codicon-arrow-up"></i></button>
      <button class="icon-btn" data-find="next" title="Next match (F3)" aria-label="Next match"><i class="codicon codicon-arrow-down"></i></button>
      <button class="icon-btn" data-find="close" title="Clear highlights (Esc)" aria-label="Clear highlights"><i class="codicon codicon-close"></i></button>`;
    bar.querySelector('.find-query').textContent = highlight.join(' ');
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-find]');
      if (!b) return;
      if (b.dataset.find === 'close') clearHits();
      else go(b.dataset.find === 'next' ? 1 : -1);
    });
    document.body.append(bar);
    return bar;
  }

  function go(delta) {
    if (!hits.length) return;
    hits[current]?.classList.remove('current');
    current = (current + delta + hits.length) % hits.length;
    const mark = hits[current];
    mark.classList.add('current');
    mark.closest('details:not([open])')?.setAttribute('open', '');
    mark.scrollIntoView({ block: 'center' });
    findBar.querySelector('.find-count').textContent = `${current + 1} of ${hits.length}`;
  }

  function clearHits() {
    for (const mark of hits) {
      const parent = mark.parentNode;
      mark.replaceWith(mark.textContent);
      parent?.normalize();
    }
    hits.length = 0;
    findBar?.remove();
    findBar = null;
  }

  let findBar = hits.length ? buildFindBar() : null;
  if (findBar) {
    document.addEventListener('keydown', (e) => {
      if (!findBar) return;
      if (e.key === 'F3' || (e.key === 'Enter' && e.target === document.body)) {
        e.preventDefault();
        go(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        clearHits();
      }
    });
    // Open at the first match.
    go(1);
  } else {
    // Open at the latest message, like a chat.
    window.scrollTo(0, document.documentElement.scrollHeight);
  }
  onScroll();
})();
