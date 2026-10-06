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

  // The hero and the sticky top bar each have a tool-call switch; they stay in step.
  const toggles = Array.from(document.querySelectorAll('[data-tools-toggle]'));
  const applyTools = (show) => {
    toggles.forEach((t) => (t.checked = show));
    document.body.classList.toggle('hide-tools', toggles.length > 0 && !show);
  };
  toggles.forEach((t) =>
    t.addEventListener('change', () => {
      saved.showTools = t.checked;
      vscode.setState({ ...saved });
      applyTools(t.checked);
    }),
  );
  applyTools(saved.showTools !== false);

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

  // ---------- stats ----------

  // Widths are set here because the page's CSP doesn't allow inline style attributes.
  document.querySelectorAll('.meter [data-fill]').forEach((el) => {
    el.style.width = `${Math.min(100, Number(el.dataset.fill) * 100)}%`;
  });

  function duration(ms) {
    const min = Math.max(1, Math.round(ms / 60000));
    if (min < 60) return `${min}m`;
    const hr = Math.round(min / 60);
    return hr < 48 ? `${hr}h` : `${Math.round(hr / 24)}d`;
  }

  /** The prompt cache tile and its top-bar twin count down while the cache is warm, then say how long ago it expired. */
  const cacheTile = document.querySelector('.stat.cache');
  const cacheShort = document.querySelector('.topbar-stats .cache');
  function updateCache() {
    const el = cacheTile || cacheShort;
    if (!el) return;
    const left = Number(el.dataset.expires) - Date.now();
    const warm = left > 0;
    if (cacheTile) {
      cacheTile.classList.toggle('warm', warm);
      cacheTile.querySelector('[data-cache-value]').textContent = warm ? `${duration(left)} left` : 'Expired';
      cacheTile.querySelector('[data-cache-sub]').textContent = warm ? 'Warm' : `${duration(-left)} ago`;
    }
    if (cacheShort) {
      cacheShort.classList.toggle('warm', warm);
      cacheShort.querySelector('[data-cache-short]').textContent = warm ? `cache ${duration(left)} left` : 'cache expired';
    }
  }
  updateCache();
  setInterval(updateCache, 30_000);

  // The compact stats appear in the top bar once the title and stats tiles have scrolled away.
  const hero = document.querySelector('.hero');
  if (hero && document.querySelector('.topbar-stats')) {
    new IntersectionObserver(([entry]) => document.body.classList.toggle('hero-hidden', !entry.isIntersecting), {
      rootMargin: `-${document.querySelector('.topbar').offsetHeight}px 0px 0px 0px`,
    }).observe(hero);
    document.getElementById('to-top').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }

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
