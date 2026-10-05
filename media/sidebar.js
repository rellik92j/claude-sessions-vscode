// Sidebar webview: renders the session list posted by SidebarView and sends user actions back.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  /** Group key -> true when collapsed. Missing keys fall back to the extension's default. */
  const collapsed = saved.collapsed || {};
  let query = saved.query || '';
  let state = null;
  /**
   * Latest results from the extension, which does the matching (query syntax, card text and transcripts):
   * the query they answer, matching session ids, transcript snippets by id, and the words to highlight.
   */
  let search = { query: '', ids: null, snippets: {}, highlight: [] };

  const LIVE_MS = 3 * 60 * 1000;

  const app = document.getElementById('app');
  app.innerHTML = `
    <header class="toolbar">
      <label class="search">
        <i class="codicon codicon-search"></i>
        <input id="q" type="text" placeholder="Search sessions and transcripts" title="Search titles, prompts and transcripts. &quot;exact phrase&quot;, -word to exclude, a OR b for either." spellcheck="false" aria-label="Search sessions and transcripts" />
        <button class="icon-btn clear" id="clear" title="Clear (Esc)" aria-label="Clear search"><i class="codicon codicon-close"></i></button>
      </label>
      <div class="controls">
        <div class="segmented" role="radiogroup" aria-label="Group sessions by">
          <button role="radio" data-group="project" title="Group by project"><i class="codicon codicon-folder"></i><span>Projects</span></button>
          <button role="radio" data-group="date" title="Group by date"><i class="codicon codicon-history"></i><span>Recent</span></button>
        </div>
        <button class="chip" id="ws" title="Only show sessions from the folders open in this window"><i class="codicon codicon-filter"></i><span>Workspace</span></button>
        <span class="spacer"></span>
        <button class="icon-btn" id="refresh" title="Refresh" aria-label="Refresh"><i class="codicon codicon-refresh"></i></button>
      </div>
      <div class="summary" id="summary"></div>
    </header>
    <main id="list" class="list" role="list" aria-label="Claude Code sessions"></main>`;

  const $q = document.getElementById('q');
  const $list = document.getElementById('list');
  const $summary = document.getElementById('summary');
  $q.value = query;

  const save = () => vscode.setState({ collapsed, query });

  // ---------- helpers ----------

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const searching = () => !!query.trim();

  /** Words/phrases to highlight for the current query (the last results' until new ones arrive). */
  const words = () => (searching() ? search.highlight : []);

  /** Escapes text and wraps search matches in <mark>. */
  function hl(text, toks) {
    text = String(text ?? '');
    if (!toks.length) return esc(text);
    // Spaces in a phrase match any whitespace, as in the extension's matching.
    const pattern = (t) => t.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const re = new RegExp('(' + toks.map(pattern).join('|') + ')', 'gi');
    return text
      .split(re)
      .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
      .join('');
  }

  function relative(t, now) {
    const sec = Math.round((now - t) / 1000);
    if (sec < 45) return 'now';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.round(hr / 24);
    if (day < 7) return `${day}d`;
    const d = new Date(t);
    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short' });
  }

  const fullDate = (t) =>
    new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  function initials(label) {
    const words = String(label).split(/[\s\-_.]+/).filter(Boolean);
    const s = words.length > 1 ? words[0][0] + words[1][0] : String(label).slice(0, 2);
    return s.toUpperCase();
  }

  // While new results are on their way, the previous ones keep filtering the list.
  function matches(s) {
    return !searching() || !search.ids || search.ids.has(s.id);
  }

  /** Asks the extension to search for the current query. */
  function requestSearch() {
    if (searching()) vscode.postMessage({ type: 'search', query });
  }

  const searchPending = () => searching() && search.query !== query;

  const DATE_ICONS = { Today: 'calendar', Yesterday: 'history', 'Previous 7 Days': 'history', 'Previous 30 Days': 'history', Older: 'archive' };

  // ---------- rendering ----------

  function renderCard(s, showProject, toks, now) {
    const live = now - s.lastTime < LIVE_MS;
    const ctx = JSON.stringify({
      webviewSection: 'session',
      sessionId: s.id,
      sessionHasPr: !!s.prNumber,
      preventDefaultContextMenuItems: true,
    });
    const meta = [
      showProject ? `<span class="tag project" style="--hue:${s.hue}"><span class="swatch"></span>${hl(s.project, toks)}</span>` : '',
      s.agent ? `<span class="tag agent" title="Agent"><i class="codicon codicon-hubot"></i>${hl(s.agent, toks)}</span>` : '',
      s.branch ? `<span class="tag" title="Git branch"><i class="codicon codicon-git-branch"></i>${hl(s.branch, toks)}</span>` : '',
      `<span class="tag" title="${s.prompts} prompt${s.prompts === 1 ? '' : 's'}${s.peers ? `, ${s.peers} message${s.peers === 1 ? '' : 's'} from other sessions` : ''}"><i class="codicon codicon-comment"></i>${s.prompts + s.peers}</span>`,
      s.prNumber
        ? `<button class="tag pr" data-action="openPr" title="Open pull request ${esc(s.prRepository || '')}#${s.prNumber}"><i class="codicon codicon-git-pull-request"></i>#${s.prNumber}</button>`
        : '',
    ].join('');
    return `
      <div class="card${live ? ' is-live' : ''}" role="listitem" tabindex="-1" data-id="${esc(s.id)}" data-vscode-context='${esc(ctx)}'>
        <div class="card-head">
          ${live ? '<span class="live" title="Active in the last few minutes"></span>' : ''}
          <div class="title">${hl(s.title, toks)}</div>
          <time data-t="${s.lastTime}" title="${esc(fullDate(s.lastTime))}">${relative(s.lastTime, now)}</time>
        </div>
        ${excerptHtml(s, toks)}
        <div class="meta">${meta}</div>
        <div class="card-actions">
          <button class="icon-btn accent" data-action="resume" title="Resume in Claude Code terminal (Ctrl+Enter)"><i class="codicon codicon-play"></i></button>
          ${state.hasClaudeCode ? '<button class="icon-btn" data-action="openInClaudeCode" title="Open in Claude Code chat"><i class="codicon codicon-comment-discussion"></i></button>' : ''}
          <button class="icon-btn" data-action="openTranscript" title="Read transcript (Enter)"><i class="codicon codicon-book"></i></button>
          <button class="icon-btn" data-action="copyId" title="Copy session ID"><i class="codicon codicon-copy"></i></button>
        </div>
      </div>`;
  }

  // When the card itself doesn't explain the match, show where the transcript matched instead of the latest prompt.
  function excerptHtml(s, toks) {
    const snippet = searching() && search.snippets[s.id];
    if (snippet) {
      return `<div class="excerpt transcript-match" title="Found in the transcript"><i class="codicon codicon-quote"></i>${hl(snippet, toks)}</div>`;
    }
    return s.excerpt ? `<div class="excerpt">${hl(s.excerpt, toks)}</div>` : '';
  }

  function renderGroup(g, toks, now) {
    const sessions = g.sessions.filter(matches);
    if (!sessions.length) return '';
    const isCollapsed = searching() ? false : collapsed[g.key] ?? !g.expanded;
    const avatar =
      g.kind === 'project'
        ? `<span class="avatar" style="--hue:${g.hue}">${esc(initials(g.label))}</span>`
        : `<span class="avatar date"><i class="codicon codicon-${DATE_ICONS[g.label] || 'calendar'}"></i></span>`;
    return `
      <section class="group${isCollapsed ? ' collapsed' : ''}" data-key="${esc(g.key)}">
        <button class="group-header" aria-expanded="${!isCollapsed}" title="${esc(g.path || g.label)}"${
          g.path
            ? ` data-vscode-context='${esc(JSON.stringify({ webviewSection: 'project', projectPath: g.path, preventDefaultContextMenuItems: true }))}'`
            : ''
        }>
          <i class="codicon codicon-chevron-right chevron"></i>
          ${avatar}
          <span class="group-text">
            <span class="group-label">${esc(g.label)}</span>
            ${g.path ? `<span class="group-path">${esc(g.path)}</span>` : ''}
          </span>
          <span class="count">${sessions.length}</span>
        </button>
        <div class="cards">${isCollapsed ? '' : sessions.map((s) => renderCard(s, g.kind === 'date', toks, now)).join('')}</div>
      </section>`;
  }

  function emptyState(icon, title, body, action) {
    return `
      <div class="empty">
        <div class="empty-icon"><i class="codicon codicon-${icon}"></i></div>
        <h3>${esc(title)}</h3>
        <p>${esc(body)}</p>
        ${action || ''}
      </div>`;
  }

  function render() {
    document.querySelectorAll('[data-group]').forEach((b) => {
      const on = state && b.dataset.group === state.groupBy;
      b.classList.toggle('active', !!on);
      b.setAttribute('aria-checked', String(!!on));
    });
    const ws = document.getElementById('ws');
    ws.setAttribute('aria-pressed', String(!!state?.workspaceOnly));
    document.getElementById('clear').hidden = !query;

    if (!state || !state.loaded) {
      $summary.textContent = '';
      $list.innerHTML = Array.from({ length: 5 }, () => '<div class="card skeleton"><div></div><div></div><div></div></div>').join('');
      return;
    }

    const toks = words();
    const now = Date.now();
    const html = state.groups.map((g) => renderGroup(g, toks, now)).join('');
    const shown = state.groups.reduce((n, g) => n + g.sessions.filter(matches).length, 0);
    const projects = new Set(state.groups.flatMap((g) => g.sessions.map((s) => s.projectPath.toLowerCase()))).size;
    $summary.textContent = searching()
      ? `${shown} of ${state.total} sessions`
      : `${state.total} session${state.total === 1 ? '' : 's'} · ${projects} project${projects === 1 ? '' : 's'}`;

    if (state.hiddenByFilter) {
      $list.innerHTML = emptyState(
        'filter',
        'Nothing in this workspace',
        'None of your Claude Code sessions were started in the folders open in this window.',
        '<button class="btn" id="show-all">Show all projects</button>',
      );
    } else if (state.total === 0) {
      $list.innerHTML = emptyState(
        'comment-discussion',
        'No sessions yet',
        'Run claude in a terminal and your sessions will show up here automatically.',
      );
    } else if (!html && searchPending()) {
      // Transcript results are on their way; avoid flashing "No matches".
      $list.innerHTML = '';
    } else if (!html) {
      $list.innerHTML = emptyState('search', 'No matches', `Nothing matches “${query}”. Try fewer words, or check the quotes and minus signs.`);
    } else {
      $list.innerHTML = html;
    }
    ensureFocusable();
  }

  /** Roving tabindex: exactly one card/header is in the tab order. */
  function ensureFocusable() {
    const items = navItems();
    if (items.length && !items.some((el) => el.tabIndex === 0)) {
      items[0].tabIndex = 0;
    }
  }

  const navItems = () => Array.from($list.querySelectorAll('.group-header, .card:not(.skeleton)'));

  function moveFocus(from, delta) {
    const items = navItems();
    const i = items.indexOf(from);
    const next = items[Math.max(0, Math.min(items.length - 1, i + delta))];
    if (next && next !== from) {
      items.forEach((el) => (el.tabIndex = -1));
      next.tabIndex = 0;
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    }
  }

  function updateTimes() {
    const now = Date.now();
    $list.querySelectorAll('time[data-t]').forEach((el) => {
      el.textContent = relative(Number(el.dataset.t), now);
    });
  }

  // ---------- events ----------

  const run = (command, id, keepOpen = false) =>
    vscode.postMessage({ type: 'run', command, id, highlight: command === 'openTranscript' ? words() : undefined, keepOpen });

  $list.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]');
    const card = e.target.closest('.card');
    if (e.target.closest('#show-all')) {
      vscode.postMessage({ type: 'setWorkspaceOnly', value: false });
      return;
    }
    const header = e.target.closest('.group-header');
    if (header) {
      const key = header.parentElement.dataset.key;
      const group = state.groups.find((g) => g.key === key);
      const nowCollapsed = !header.parentElement.classList.contains('collapsed');
      collapsed[key] = nowCollapsed;
      save();
      if (!nowCollapsed && group) {
        // Render the cards lazily on expand.
        header.parentElement.querySelector('.cards').innerHTML = group.sessions
          .filter(matches)
          .map((s) => renderCard(s, group.kind === 'date', words(), Date.now()))
          .join('');
      }
      header.parentElement.classList.toggle('collapsed', nowCollapsed);
      header.setAttribute('aria-expanded', String(!nowCollapsed));
      return;
    }
    if (!card) return;
    if (action) {
      e.stopPropagation();
      run(action.dataset.action, card.dataset.id);
    } else {
      run('openTranscript', card.dataset.id);
    }
  });

  // Like VS Code's explorer: a click previews the transcript in the shared tab, a double-click keeps it open.
  $list.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card && !e.target.closest('[data-action], .group-header')) {
      run('openTranscript', card.dataset.id, true);
    }
  });

  $list.addEventListener('keydown', (e) => {
    const item = e.target.closest('.group-header, .card');
    if (!item) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(item, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (navItems()[0] === item) $q.focus();
      else moveFocus(item, -1);
    } else if (e.key === 'Enter' && item.classList.contains('card') && !e.target.closest('button')) {
      e.preventDefault();
      run(e.ctrlKey || e.metaKey ? 'resume' : 'openTranscript', item.dataset.id);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && item.classList.contains('group-header')) {
      const isCollapsed = item.parentElement.classList.contains('collapsed');
      if ((e.key === 'ArrowLeft') !== isCollapsed) item.click();
    }
  });

  $list.addEventListener('focusin', (e) => {
    const item = e.target.closest('.group-header, .card');
    if (item) {
      navItems().forEach((el) => (el.tabIndex = el === item ? 0 : -1));
    }
  });

  let searchTimer;
  $q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = $q.value;
      save();
      requestSearch();
      render();
    }, 60);
  });
  $q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $q.value) {
      e.stopPropagation();
      $q.value = '';
      query = '';
      save();
      render();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      const first = $list.querySelector('.card') || navItems()[0];
      if (first) {
        e.preventDefault();
        if (e.key === 'Enter' && query) {
          run('openTranscript', first.dataset.id);
        } else {
          first.focus();
        }
      }
    }
  });
  document.getElementById('clear').addEventListener('click', () => {
    $q.value = '';
    query = '';
    save();
    render();
    $q.focus();
  });

  document.querySelectorAll('[data-group]').forEach((b) =>
    b.addEventListener('click', () => vscode.postMessage({ type: 'setGroupBy', value: b.dataset.group })),
  );
  document.getElementById('ws').addEventListener('click', () =>
    vscode.postMessage({ type: 'setWorkspaceOnly', value: !state?.workspaceOnly }),
  );
  document.getElementById('refresh').addEventListener('click', (e) => {
    const icon = e.currentTarget.querySelector('.codicon');
    icon.classList.add('spin');
    setTimeout(() => icon.classList.remove('spin'), 700);
    vscode.postMessage({ type: 'refresh' });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $q) {
      e.preventDefault();
      $q.focus();
      $q.select();
    }
  });

  $list.addEventListener('scroll', () => document.body.classList.toggle('scrolled', $list.scrollTop > 2), { passive: true });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg?.type === 'state') {
      // Keep keyboard focus on the same card across re-renders.
      const focusedId = document.activeElement?.closest?.('.card')?.dataset.id;
      state = msg;
      // Sessions may have changed; refresh transcript matches (the previous ones stay shown meanwhile).
      requestSearch();
      render();
      if (focusedId) {
        const el = $list.querySelector(`.card[data-id="${CSS.escape(focusedId)}"]`);
        if (el) {
          navItems().forEach((n) => (n.tabIndex = -1));
          el.tabIndex = 0;
          el.focus({ preventScroll: true });
        }
      }
    } else if (msg?.type === 'searchResults') {
      if (msg.query === query) {
        search = { query: msg.query, ids: new Set(msg.ids || []), snippets: msg.snippets || {}, highlight: msg.highlight || [] };
        render();
      }
    } else if (msg?.type === 'focusSearch') {
      $q.focus();
      $q.select();
    }
  });

  setInterval(updateTimes, 30_000);
  render();
  vscode.postMessage({ type: 'ready' });
})();
