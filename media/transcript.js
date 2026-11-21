// Transcript page interactions: header actions, copy buttons, tool toggle, jump-to-latest.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

  document.addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-cmd]');
    if (cmd) {
      vscode.postMessage({ command: cmd.dataset.cmd, arg: cmd.dataset.arg });
      return;
    }
    const jumpTo = e.target.closest('[data-jump]');
    if (jumpTo) {
      e.preventDefault();
      const target = document.getElementById(jumpTo.dataset.jump);
      if (target) {
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
        target.classList.remove('flash');
        void target.offsetWidth;
        target.classList.add('flash');
      }
      if (!docked()) setSide(false);
      return;
    }
    const more = e.target.closest('[data-more]');
    if (more) {
      more.closest('.side-section').querySelectorAll('[data-extra]').forEach((li) => (li.hidden = false));
      more.remove();
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

  // ---------- new messages ----------

  // The page is rebuilt on every reload, so only messages added since the last render of this same session get the
  // entrance animation; opening a transcript, or switching this tab to another one, shows it still.
  {
    const msgs = document.querySelectorAll('.conversation .msg');
    const key = document.body.dataset.session;
    if (key && saved.seen?.key === key) {
      for (let i = saved.seen.count; i < msgs.length; i++) msgs[i].classList.add('new');
    }
    saved.seen = { key, count: msgs.length };
    vscode.setState({ ...saved });
  }

  // The transcriptLineWidth setting, changed while the tab is open.
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'lineWidth') {
      document.body.classList.remove('line-full', 'line-comfortable', 'line-narrow');
      document.body.classList.add(`line-${e.data.value}`);
    }
  });

  // ---------- message box ----------

  // Type the next message at the bottom of the transcript; it goes to this session or, when that isn't wise or
  // possible, to a new session with a handoff that ends with it. The line under the box always says which.
  const composer = document.getElementById('composer');
  if (composer) {
    const cfg = JSON.parse(composer.dataset.composer);
    const input = document.getElementById('composer-input');
    const sendBtn = document.getElementById('composer-send');
    const moreBtn = document.getElementById('composer-more');
    const menu = document.getElementById('composer-menu');
    const status = document.getElementById('composer-status');
    const key = document.body.dataset.session || '';
    const drafts = saved.drafts || {};
    let target = cfg.target;
    /** Set when chosen in the menu; otherwise the default for the target. */
    let chosenMode = null;
    let sending = false;

    const info = () => cfg.targets.find((t) => t.id === target) || cfg.targets[0];
    /** An expired cache only tips the default to a handoff from this many tokens of context. */
    const LARGE_CONTEXT = 100_000;
    /**
     * Why this session shouldn't simply be resumed, if there is a reason: a nearly full context, or an expired prompt
     * cache on a large conversation, since resuming then pays to cache all of it again while a handoff starts small.
     * While the cache is warm, or the conversation is small, resuming is the cheap way on.
     */
    const reason = () =>
      cfg.context
        ? `Context is ${cfg.context}% full.`
        : cfg.cacheExpires && Date.now() >= cfg.cacheExpires && cfg.contextTokens >= LARGE_CONTEXT
          ? `The prompt cache has expired, so resuming would pay to cache all ${Math.round(cfg.contextTokens / 1000)}k tokens again.`
          : '';
    const mode = () => (!info().same ? 'handoff' : chosenMode || (reason() ? 'handoff' : 'same'));

    function describe() {
      const t = info();
      let text;
      if (mode() === 'same') {
        text = t.id === 'claude-chat' ? 'Opens this session in the Claude Code chat, with your message in its input box.' : `Resumes this session in ${t.label} and sends your message.`;
      } else if (t.id === 'claude-chat') {
        text = 'Opens a new Claude Code chat with a handoff of this session and your message in its input box.';
      } else {
        text = `Starts a new session in ${t.label} with a handoff of this one, then sends your message.`;
      }
      const why = mode() === 'handoff' && !chosenMode ? (t.same ? reason() : cfg.targets[0].id === t.id ? `${t.label} can't take a message into an existing chat.` : '') : '';
      status.innerHTML = `<i class="codicon codicon-${t.icon}"></i><span>${esc(text)}</span>${why ? `<span class="why">${esc(why)}</span>` : ''}`;
    }

    function esc(s) {
      return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    }

    function grow() {
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight}px`;
      sendBtn.disabled = sending || !input.value.trim();
    }

    function saveDraft() {
      if (input.value) drafts[key] = input.value;
      else delete drafts[key];
      saved.drafts = drafts;
      vscode.setState({ ...saved });
    }

    function send(pickModel) {
      const text = input.value.trim();
      if (!text || sending) return;
      sending = true;
      sendBtn.disabled = true;
      setMenu(false);
      vscode.postMessage({ command: 'send', text, target, mode: mode(), pickModel: !!pickModel });
    }

    function renderMenu() {
      const m = mode();
      const t = info();
      const item = (attrs, icon, label, on, disabled, title) =>
        `<button role="menuitemradio" aria-checked="${on}" ${attrs}${disabled ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}><i class="codicon codicon-${on ? 'check' : icon}"></i><span>${esc(label)}</span></button>`;
      menu.innerHTML =
        `<div class="menu-label">Send to</div>` +
        item('data-mode="same"', 'blank', 'This session', m === 'same', !t.same, t.same ? '' : `${t.label} can't continue this session`) +
        item('data-mode="handoff"', 'blank', 'A new session, with a handoff', m === 'handoff', false) +
        `<div class="menu-label">In</div>` +
        cfg.targets.map((x) => item(`data-target="${x.id}"`, x.icon, x.label, x.id === target, false)).join('') +
        (t.cli ? `<div class="menu-sep"></div><button role="menuitem" data-pick-model${input.value.trim() ? '' : ' disabled'}><i class="codicon codicon-settings"></i><span>Send with a model and effort…</span></button>` : '');
    }

    function setMenu(open) {
      menu.hidden = !open;
      moreBtn.setAttribute('aria-expanded', String(open));
      if (open) {
        renderMenu();
        menu.querySelector('button:not([disabled])')?.focus();
      }
    }

    menu.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if ('pickModel' in b.dataset) {
        send(true);
        return;
      }
      if (b.dataset.mode) chosenMode = b.dataset.mode;
      if (b.dataset.target) {
        target = b.dataset.target;
        if (!info().same) chosenMode = null;
      }
      renderMenu();
      describe();
      input.focus();
    });
    menu.addEventListener('keydown', (e) => {
      const items = Array.from(menu.querySelectorAll('button:not([disabled])'));
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.stopPropagation();
        setMenu(false);
        moreBtn.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    });
    moreBtn.addEventListener('click', () => setMenu(menu.hidden));
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !e.target.closest('#composer-menu, #composer-more')) setMenu(false);
    });

    input.addEventListener('input', () => {
      grow();
      saveDraft();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send(false);
      }
    });
    sendBtn.addEventListener('click', () => send(false));

    window.addEventListener('message', (e) => {
      if (e.data?.type === 'sent') {
        sending = false;
        input.value = '';
        saveDraft();
        grow();
      } else if (e.data?.type === 'sendFailed') {
        // Cancelled or refused: the text stays, ready to send again.
        sending = false;
        grow();
        input.focus();
      }
    });

    // The cache can lapse while the tab is open, which changes the default.
    setInterval(describe, 30_000);
    input.value = drafts[key] || '';
    document.body.classList.add('has-composer');
    describe();
    grow();
    // The jump-to-latest button sits just above the box, whatever its height.
    new ResizeObserver(() => document.body.style.setProperty('--composer-h', `${composer.offsetHeight}px`)).observe(composer);
  }

  // ---------- session details side panel ----------

  /**
   * From this width the panel sits beside the conversation, which moves over to make room (must match the
   * min-width media query in transcript.css). Below it, the panel covers the conversation, so it starts closed
   * and only opens on request; opening or closing it there isn't remembered for wider tabs.
   */
  const SIDE_DOCK_WIDTH = 900;
  const docked = () => window.innerWidth >= SIDE_DOCK_WIDTH;
  const side = document.getElementById('side');
  const sideToggle = document.getElementById('side-toggle');
  function setSide(open, remember) {
    document.body.classList.toggle('side-open', open);
    sideToggle?.setAttribute('aria-expanded', String(open));
    sideToggle?.classList.toggle('active', open);
    if (remember && docked()) {
      saved.sideOpen = open;
      vscode.setState({ ...saved });
    }
  }
  if (side && sideToggle) {
    setSide(docked() && saved.sideOpen !== false);
    sideToggle.addEventListener('click', () => setSide(!document.body.classList.contains('side-open'), true));
    document.getElementById('side-close').addEventListener('click', () => setSide(false, true));
    // A tab that narrows (an editor split, a smaller window) closes the panel rather than letting it cover the
    // conversation; widening again brings back what was chosen while it was docked.
    let wasDocked = docked();
    window.addEventListener('resize', () => {
      const now = docked();
      if (now !== wasDocked) setSide(now && saved.sideOpen !== false);
      wasDocked = now;
    });
    // Which sections are expanded survives reloads of the tab.
    const sections = saved.sections || {};
    side.querySelectorAll('details[data-section]').forEach((d) => {
      if (d.dataset.section in sections) d.open = sections[d.dataset.section];
      d.addEventListener('toggle', () => {
        saved.sections = { ...(saved.sections || {}), [d.dataset.section]: d.open };
        vscode.setState({ ...saved });
      });
    });
  }

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
  document.querySelectorAll('.meter [data-fill], .side-bar [data-fill]').forEach((el) => {
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
