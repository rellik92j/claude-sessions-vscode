// Overview webview: renders the summary posted by OverviewPanel and sends user actions back.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let range = saved.range ?? 30;
  /** Which projects are shown: those in the open workspace folders (the default), all, or a pick. */
  let scope = ['workspace', 'all', 'pick'].includes(saved.scope) ? saved.scope : 'workspace';
  /** Keys of the picked projects, for the 'pick' scope. */
  let projects = Array.isArray(saved.projects) ? saved.projects : [];
  /** Order of the session list: 'recent' or 'cost'. */
  let sessionSort = saved.sessionSort === 'cost' ? 'cost' : 'recent';
  /** What the chart's bars are split and colored by: 'model', 'project' or 'total'. */
  let colorBy = ['model', 'project', 'total'].includes(saved.colorBy) ? saved.colorBy : 'model';
  /** Sources shown (claude, copilot-cli, vscode-chat); null until chosen, meaning all of them. */
  let sources = Array.isArray(saved.sources) ? saved.sources : null;
  let menuQuery = '';
  let state = null;

  const RANGES = [
    [7, '7 days'],
    [30, '30 days'],
    [90, '90 days'],
    [0, 'All time'],
  ];
  const PROJECTS_SHOWN = 10;
  const SESSION_SORTS = [
    ['recent', 'Recent'],
    ['cost', 'Most expensive'],
  ];
  const COLOR_BYS = [
    ['model', 'Model'],
    ['project', 'Project'],
    ['total', 'Total'],
  ];
  /** Categorical colors; models or projects past the last one share the "Other" color. */
  const SLOTS = 7;

  const app = document.getElementById('app');
  app.innerHTML = `
    <header class="head">
      <div class="head-title">
        <h1>Overview</h1>
        <div class="sub" id="sub"></div>
      </div>
      <div class="segmented" role="radiogroup" aria-label="Time range">
        ${RANGES.map(([v, label]) => `<button role="radio" data-range="${v}">${label}</button>`).join('')}
      </div>
      <button class="icon-btn" id="refresh" title="Refresh" aria-label="Refresh"><i class="codicon codicon-refresh"></i></button>
    </header>
    <div class="filters">
      <div class="dropdown">
        <button class="chip" id="project-btn" aria-haspopup="true" aria-expanded="false"><i class="codicon codicon-folder"></i><span id="project-label">Current workspace</span><i class="codicon codicon-chevron-down"></i></button>
        <div class="menu" id="project-menu" hidden>
          <div class="menu-scopes" id="project-scopes"></div>
          <input id="project-q" type="text" placeholder="Find a project" spellcheck="false" aria-label="Find a project" />
          <div class="menu-items" id="project-items"></div>
        </div>
      </div>
      <div class="selected" id="selected"></div>
      <span class="spacer"></span>
      <div class="source-chips" id="sources" role="group" aria-label="Show sessions from"></div>
    </div>
    <main id="body"></main>
    <div class="tooltip" id="tip" role="tooltip" hidden></div>`;

  const $body = document.getElementById('body');
  const $sub = document.getElementById('sub');
  const $tip = document.getElementById('tip');
  const $projectBtn = document.getElementById('project-btn');
  const $projectLabel = document.getElementById('project-label');
  const $menu = document.getElementById('project-menu');
  const $projectQ = document.getElementById('project-q');
  const $projectItems = document.getElementById('project-items');
  const $projectScopes = document.getElementById('project-scopes');
  const $selected = document.getElementById('selected');
  const $sources = document.getElementById('sources');

  // ---------- helpers ----------

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function money(usd) {
    if (usd >= 10000) return `$${(usd / 1000).toFixed(1)}k`;
    if (usd > 0 && usd < 0.01) return '<$0.01';
    return `$${usd.toFixed(usd >= 1000 ? 0 : 2)}`;
  }

  const count = (n) => n.toLocaleString();
  const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;

  /** "2026-10-05" -> local Date. */
  function parseDay(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  const shortDay = (key) => parseDay(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const longDay = (key) => parseDay(key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  function relative(t, now = Date.now()) {
    const min = Math.round((now - t) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  /** A round axis maximum at or above `v`: 1, 2, 2.5 or 5 times a power of ten. */
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) {
      if (m * p >= v) return m * p;
    }
    return 10 * p;
  }

  // ---------- colors ----------

  /**
   * Color class for a model or project: its place in the extension's all-time order (so it keeps its color when the
   * range changes), "Other" past the last slot, and hollow for a project that isn't shown at all. Only what the chart
   * is colored by gets colors, so a project never seems to match the model that shares its color.
   */
  function colorOf(kind, key) {
    if (kind !== colorBy) return 'c-x';
    const i = state?.overview.series[kind].indexOf(key) ?? -1;
    return i < 0 ? 'c-n' : i < SLOTS ? `c-${i + 1}` : 'c-o';
  }

  const projectName = (key) => state?.overview.allProjects.find((p) => p.key === key)?.name ?? key;

  /** A bucket's cost split into colored parts, in series order (largest overall at the bottom), "Other" last. */
  function parts(b) {
    if (colorBy === 'total') return b.cost ? [{ key: 'total', label: 'Cost', color: 'c-t', cost: b.cost }] : [];
    const kind = colorBy;
    const by = kind === 'model' ? b.byModel : b.byProject;
    const order = state.overview.series[kind];
    const out = [];
    let other = 0;
    for (const [key, cost] of Object.entries(by)) {
      const i = order.indexOf(key);
      if (i >= 0 && i < SLOTS) out.push({ key, i, label: kind === 'model' ? key : projectName(key), color: `c-${i + 1}`, cost });
      else other += cost;
    }
    out.sort((a, c) => a.i - c.i);
    if (other > 0) out.push({ key: 'other', label: 'Other', color: 'c-o', cost: other });
    return out;
  }

  // ---------- rendering ----------

  function kpi(label, value, note, title) {
    return `
      <div class="kpi"${title ? ` title="${esc(title)}"` : ''}>
        <div class="kpi-label">${label}</div>
        <div class="kpi-value">${value}</div>
        <div class="kpi-note">${note || '&nbsp;'}</div>
      </div>`;
  }

  function renderKpis(o) {
    const t = o.totals;
    const perDay = t.activeDays ? t.cost / t.activeDays : 0;
    // Only Claude Code logs record token usage, so with other sources shown the cost covers part of the sessions.
    const mixed = (state.sources || []).some((x) => x.on && x.id !== 'claude');
    return `
      <section class="kpis">
        ${kpi(
          mixed ? 'Cost <span class="muted">Claude only</span>' : 'Cost',
          money(t.cost),
          t.activeDays ? `${money(perDay)} per active day` : '',
          mixed
            ? 'What the Claude Code sessions would cost at Claude API prices, subagents included. GitHub Copilot CLI and VS Code Chat logs record no token usage, so they count as $0.'
            : 'What these sessions would cost at Claude API prices, subagents included',
        )}
        ${kpi('Sessions', count(t.sessions), t.sessions ? `${money(t.sessions ? t.cost / t.sessions : 0)} each on average` : '')}
        ${kpi('Prompts', count(t.prompts), t.sessions ? `${(t.prompts / t.sessions).toFixed(1)} per session` : '', 'Prompts you typed in these sessions')}
        ${kpi('Projects', count(t.projects), '')}
        ${kpi('Active days', count(t.activeDays), o.buckets.length && o.bucketDays === 1 ? `of ${o.buckets.length}` : '')}
      </section>`;
  }

  function renderLegend(o) {
    if (colorBy === 'total') return '';
    const seen = new Map();
    for (const b of o.buckets) {
      for (const p of parts(b)) {
        const e = seen.get(p.key) ?? { ...p, cost: 0 };
        e.cost += p.cost;
        seen.set(p.key, e);
      }
    }
    const items = [...seen.values()].sort((a, b) => (a.key === 'other') - (b.key === 'other') || a.i - b.i);
    if (!items.length) return '';
    return `<div class="legend">${items
      .map((p) => `<span class="legend-item"><span class="swatch ${p.color}"></span>${esc(p.label)}<span class="muted">${money(p.cost)}</span></span>`)
      .join('')}</div>`;
  }

  function renderChart(o) {
    const unit = o.bucketDays === 1 ? 'day' : 'week';
    const max = niceMax(Math.max(0, ...o.buckets.map((b) => b.cost)));
    const ticks = [max, max / 2, 0];
    const bars = o.buckets
      .map((b, i) => {
        const label = o.bucketDays === 1 ? longDay(b.start) : `Week of ${longDay(b.start)}`;
        const ps = parts(b);
        const aria = `${label}: ${money(b.cost)}, ${plural(b.sessions, 'session')}${
          colorBy === 'total' ? '' : ps.map((p) => `; ${p.label} ${money(p.cost)}`).join('')
        }`;
        const segs = ps.map((p) => `<div class="seg ${p.color}" data-h="${(p.cost / b.cost) * 100}"></div>`).join('');
        return `<div class="bar-slot" data-i="${i}" tabindex="0" aria-label="${esc(aria)}"><div class="bar${b.cost ? '' : ' empty'}" data-h="${(b.cost / max) * 100}">${segs}</div></div>`;
      })
      .join('');
    // Three date labels: first, middle and last bar.
    const n = o.buckets.length;
    const xIdx = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : [...Array(n).keys()];
    const xLabels = xIdx
      .map((i) => `<span data-x="${n > 1 ? (i / (n - 1)) * 100 : 50}">${esc(shortDay(o.buckets[i].start))}</span>`)
      .join('');
    return `
      <section class="card chart-card">
        <div class="card-head">
          <h2>Cost per ${unit}</h2>
          <span class="muted">at Claude API prices</span>
          <span class="spacer"></span>
          <span class="muted seg-label">Color by</span>
          <div class="segmented small" role="radiogroup" aria-label="Color bars by">
            ${COLOR_BYS.map(([v, label]) => `<button role="radio" data-color-by="${v}" class="${v === colorBy ? 'active' : ''}" aria-checked="${v === colorBy}">${label}</button>`).join('')}
          </div>
        </div>
        <div class="chart">
          <div class="y-axis">${ticks.map((t) => `<span>${money(t).replace('.00', '')}</span>`).join('')}</div>
          <div class="plot">
            <div class="grid">${ticks.map(() => '<div></div>').join('')}</div>
            <div class="bars" role="img" aria-label="Cost per ${unit}">${bars}</div>
            <div class="x-axis">${xLabels}</div>
          </div>
        </div>
        ${renderLegend(o)}
      </section>`;
  }

  function meter(fraction, color) {
    return `<div class="meter"><div class="${color}" data-w="${Math.max(0, Math.min(1, fraction)) * 100}"></div></div>`;
  }

  function renderProjects(o) {
    const shown = o.projects.slice(0, PROJECTS_SHOWN);
    const top = Math.max(...shown.map((p) => p.cost), 0) || 1;
    const rows = shown
      .map((p) => {
        const color = colorOf('project', p.key);
        return `
        <tr>
          <td class="name"><span class="name-cell"><button class="link" data-only="${esc(p.key)}" title="${esc(p.path)}\nShow only this project"><span class="swatch ${color}"></span>${esc(p.name)}</button><button class="icon-btn small" data-folder="${esc(p.path)}" title="Open folder in a new window" aria-label="Open ${esc(p.name)} in a new window"><i class="codicon codicon-folder-opened"></i></button></span></td>
          <td class="num">${count(p.sessions)}</td>
          <td class="num">${count(p.prompts)}</td>
          <td class="num cost">${money(p.cost)}${meter(p.cost / top, color)}</td>
          <td class="num muted">${relative(p.lastTime)}</td>
        </tr>`;
      })
      .join('');
    const more = o.projects.length - shown.length;
    return `
      <section class="card">
        <div class="card-head"><h2>Projects</h2><span class="muted">by cost</span></div>
        <table>
          <thead><tr><th>Project</th><th class="num">Sessions</th><th class="num">Prompts</th><th class="num">Cost</th><th class="num">Last active</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${more > 0 ? `<div class="more muted">and ${plural(more, 'more project')}</div>` : ''}
      </section>`;
  }

  function renderModels(o) {
    const total = o.models.reduce((n, m) => n + m.cost, 0) || 1;
    const rows = o.models
      .map((m) => {
        const color = colorOf('model', m.model);
        return `
        <tr>
          <td class="name"><span class="name-cell"><span class="swatch ${color}"></span>${esc(m.model)}</span></td>
          <td class="num cost">${money(m.cost)}${meter(m.cost / total, color)}</td>
          <td class="num muted">${m.cost / total < 0.005 ? '&lt;1' : Math.round((m.cost / total) * 100)}%</td>
        </tr>`;
      })
      .join('');
    return `
      <section class="card">
        <div class="card-head"><h2>Models</h2><span class="muted">share of cost</span></div>
        ${rows ? `<table><thead><tr><th>Model</th><th class="num">Cost</th><th class="num">Share</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="muted pad">No priced usage in this range.</div>'}
      </section>`;
  }

  function renderSessions(o) {
    const list = sessionSort === 'cost' ? o.topSessions : o.recentSessions;
    const rows = list
      .map(
        (s) => `
        <button class="session" data-id="${esc(s.id)}" title="Open transcript">
          <span class="session-title">${esc(s.title)}</span>
          <span class="session-meta">
            <span class="tag"><span class="swatch ${colorOf('project', s.projectKey)}"></span>${esc(s.project)}</span>
            <span class="tag"><i class="codicon codicon-comment"></i>${count(s.prompts)}</span>
            <span class="tag muted">${relative(s.lastTime)}</span>
          </span>
          <span class="session-cost">${money(s.cost)}</span>
        </button>`,
      )
      .join('');
    return `
      <section class="card">
        <div class="card-head">
          <h2>Sessions</h2><span class="muted">${sessionSort === 'cost' ? 'most expensive, cost in this range' : 'most recently active'}</span>
          <span class="spacer"></span>
          <div class="segmented small" role="radiogroup" aria-label="Sort sessions by">
            ${SESSION_SORTS.map(([v, label]) => `<button role="radio" data-sort="${v}" class="${v === sessionSort ? 'active' : ''}" aria-checked="${v === sessionSort}">${label}</button>`).join('')}
          </div>
        </div>
        ${rows ? `<div class="sessions">${rows}</div>` : '<div class="muted pad">No priced usage in this range.</div>'}
      </section>`;
  }

  // ---------- project filter ----------

  const save = () => vscode.setState({ range, scope, projects, sessionSort, colorBy, sources });
  const postFilters = () => vscode.postMessage({ type: 'setFilters', range, scope, projects, ...(sources ? { sources } : {}) });

  /**
   * Source chips work as a filter: with everything shown, clicking a source shows just that one; clicking another adds
   * it; clicking a chosen one removes it, and removing the last one (or choosing them all) goes back to everything.
   * Returns the sources to show, or null for all of them.
   */
  function nextSources(chips, id) {
    const all = chips.every((x) => x.on);
    const chosen = chips.filter((x) => x.on).map((x) => x.id);
    if (all) return [id];
    const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
    return next.length === 0 || next.length === chips.length ? null : next;
  }

  /** All, then a chip per source; while all are shown, only All is lit. */
  function renderSources() {
    const list = state?.sources || [];
    if (!list.length) {
      $sources.innerHTML = '';
      return;
    }
    const all = list.every((x) => x.on);
    const chip = (id, on, title, inner) =>
      `<button class="chip${on ? ' on' : ''}" data-source="${esc(id)}" aria-pressed="${on}" title="${esc(title)}">${inner}</button>`;
    $sources.innerHTML =
      chip('*', all, 'Show sessions from every source', 'All') +
      list
        .map((x) =>
          chip(x.id, !all && x.on, `${x.title}${all ? ': show only these' : x.on ? ': stop showing these' : ': show these too'}`, `<i class="codicon codicon-${esc(x.icon)}"></i><span>${esc(x.label)}</span>`),
        )
        .join('');
  }

  function setScope(next, picked = projects) {
    scope = next;
    projects = picked;
    save();
    postFilters();
  }

  /** The scope in effect: the extension shows all projects when no folder is open. */
  const shownScope = () => state?.scope ?? scope;

  /** Keys of the projects currently shown, or null for all. */
  const shownKeys = () => state?.overview.filter ?? null;

  /** Shows just these projects; none goes back to all of them. */
  const pick = (keys) => (keys.length ? setScope('pick', keys) : setScope('all', []));

  function renderFilter() {
    const all = state?.overview.allProjects ?? [];
    const byKey = new Map(all.map((p) => [p.key, p]));
    const current = shownScope();
    const chosen = current === 'pick' ? (shownKeys() ?? []).map((k) => byKey.get(k)).filter(Boolean) : [];
    $projectLabel.textContent =
      current === 'workspace'
        ? 'Current workspace'
        : current === 'all'
          ? 'All projects'
          : chosen.length === 1
            ? chosen[0].name
            : `${chosen.length} projects`;
    $projectBtn.title = current === 'workspace' && state?.workspaceName ? `Projects in ${state.workspaceName}` : '';
    $projectBtn.classList.toggle('on', current === 'pick');
    $selected.innerHTML = chosen
      .map(
        (p) =>
          `<span class="pill" title="${esc(p.path)}"><span class="swatch ${colorOf('project', p.key)}"></span>${esc(p.name)}<button class="pill-x" data-remove="${esc(p.key)}" title="Remove filter" aria-label="Remove ${esc(p.name)}"><i class="codicon codicon-close"></i></button></span>`,
      )
      .join('');
    renderMenu();
  }

  function renderMenu() {
    const current = shownScope();
    const scopeItem = (value, icon, label, note) => `
      <button class="menu-item scope" data-scope="${value}" role="menuitemradio" aria-checked="${current === value}">
        <i class="codicon codicon-${current === value ? 'check' : 'blank'}"></i><i class="codicon codicon-${icon}"></i>
        <span class="menu-name">${label}</span>${note ? `<span class="muted menu-time">${esc(note)}</span>` : ''}
      </button>`;
    $projectScopes.innerHTML =
      (state?.hasWorkspace ? scopeItem('workspace', 'root-folder', 'Current workspace', state.workspaceName) : '') +
      scopeItem('all', 'folder-library', 'All projects', '');

    const all = state?.overview.allProjects ?? [];
    const checked = new Set(current === 'all' ? [] : shownKeys() ?? []);
    const q = menuQuery.trim().toLowerCase();
    const shown = q ? all.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)) : all;
    $projectItems.innerHTML = shown.length
      ? shown
          .map(
            (p) => `
          <label class="menu-item" title="${esc(p.path)}">
            <input type="checkbox" data-key="${esc(p.key)}"${checked.has(p.key) ? ' checked' : ''} />
            <span class="swatch ${colorOf('project', p.key)}"></span>
            <span class="menu-name">${esc(p.name)}</span>
            <span class="muted menu-time">${relative(p.lastTime)}</span>
          </label>`,
          )
          .join('')
      : '<div class="muted menu-empty">No matching projects</div>';
  }

  function openMenu(open) {
    $menu.hidden = !open;
    $projectBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      menuQuery = '';
      $projectQ.value = '';
      renderMenu();
      $projectQ.focus();
    }
  }

  /** The page's CSP allows no inline style attributes, so sizes are set through the DOM. */
  function paint(root) {
    for (const el of root.querySelectorAll('[data-h]')) el.style.height = `${el.dataset.h}%`;
    for (const el of root.querySelectorAll('[data-w]')) el.style.width = `${el.dataset.w}%`;
    for (const el of root.querySelectorAll('[data-x]')) el.style.left = `${el.dataset.x}%`;
  }

  function render() {
    for (const b of document.querySelectorAll('[data-range]')) {
      const on = Number(b.dataset.range) === range;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
    if (!state || !state.loaded) {
      $sub.textContent = '';
      $body.innerHTML = '<div class="empty-state muted">Loading sessions…</div>';
      return;
    }
    renderFilter();
    renderSources();
    const o = state.overview;
    $sub.textContent = o.from === o.to ? longDay(o.to) : `${longDay(o.from)} – ${longDay(o.to)}`;
    if (!o.totals.sessions) {
      const where = { workspace: ' from this workspace', pick: ' for the chosen projects', all: '' }[shownScope()];
      $body.innerHTML = `<div class="empty-state muted">No sessions in this range${where}.${
        where ? '<div><button class="link" data-scope="all">Show all projects</button></div>' : ''
      }</div>`;
      return;
    }
    $body.innerHTML = `
      ${renderKpis(o)}
      ${renderChart(o)}
      <div class="columns">
        ${renderProjects(o)}
        ${renderModels(o)}
      </div>
      ${renderSessions(o)}`;
    paint($body);
  }

  // ---------- tooltip ----------

  function showTip(slot) {
    const b = state?.overview.buckets[Number(slot.dataset.i)];
    if (!b) return;
    const o = state.overview;
    const label = o.bucketDays === 1 ? longDay(b.start) : `Week of ${longDay(b.start)}`;
    const breakdown =
      colorBy === 'total'
        ? ''
        : [...parts(b)]
            .sort((a, c) => c.cost - a.cost)
            .map((p) => `<div class="tip-row"><span><span class="swatch ${p.color}"></span>${esc(p.label)}</span><b>${money(p.cost)}</b></div>`)
            .join('');
    $tip.innerHTML = `<div class="tip-title">${esc(label)}</div>
      <div class="tip-row"><span>Cost</span><b>${money(b.cost)}</b></div>
      <div class="tip-row"><span>Sessions</span><b>${count(b.sessions)}</b></div>
      ${breakdown ? `<div class="tip-split">${breakdown}</div>` : ''}`;
    $tip.hidden = false;
    const r = slot.getBoundingClientRect();
    const t = $tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
    const top = r.top - t.height - 6 < 8 ? r.bottom + 6 : r.top - t.height - 6;
    $tip.style.left = `${left}px`;
    $tip.style.top = `${top}px`;
    slot.classList.add('hover');
  }

  function hideTip() {
    $tip.hidden = true;
    for (const el of document.querySelectorAll('.bar-slot.hover')) el.classList.remove('hover');
  }

  $body.addEventListener('mouseover', (e) => {
    const slot = e.target.closest('.bar-slot');
    hideTip();
    if (slot) showTip(slot);
  });
  $body.addEventListener('mouseleave', hideTip);
  $body.addEventListener('focusin', (e) => {
    const slot = e.target.closest('.bar-slot');
    hideTip();
    if (slot) showTip(slot);
  });
  $body.addEventListener('focusout', hideTip);
  window.addEventListener('scroll', hideTip, true);

  // ---------- events ----------

  document.addEventListener('click', (e) => {
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      sessionSort = sortBtn.dataset.sort;
      save();
      render();
      return;
    }
    const colorBtn = e.target.closest('[data-color-by]');
    if (colorBtn) {
      colorBy = colorBtn.dataset.colorBy;
      save();
      render();
      return;
    }
    const rangeBtn = e.target.closest('[data-range]');
    if (rangeBtn) {
      range = Number(rangeBtn.dataset.range);
      save();
      render();
      postFilters();
      return;
    }
    const sourceBtn = e.target.closest('[data-source]');
    if (sourceBtn && state) {
      const id = sourceBtn.dataset.source;
      sources = (id === '*' ? null : nextSources(state.sources, id)) ?? ['claude', 'copilot-cli', 'vscode-chat'];
      save();
      postFilters();
      return;
    }
    const scopeBtn = e.target.closest('[data-scope]');
    if (scopeBtn) {
      openMenu(false);
      setScope(scopeBtn.dataset.scope);
      return;
    }
    if (e.target.closest('#project-btn')) {
      openMenu($menu.hidden);
      return;
    }
    if (e.target.closest('#project-menu')) return;
    openMenu(false);
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      pick((shownKeys() ?? []).filter((k) => k !== remove.dataset.remove));
      return;
    }
    const only = e.target.closest('[data-only]');
    if (only) {
      // Clicking the only project shown goes back to all of them.
      const keys = shownKeys();
      pick(shownScope() === 'pick' && keys.length === 1 && keys[0] === only.dataset.only ? [] : [only.dataset.only]);
      return;
    }
    if (e.target.closest('#refresh')) {
      vscode.postMessage({ type: 'refresh' });
      return;
    }
    const folder = e.target.closest('[data-folder]');
    if (folder) {
      vscode.postMessage({ type: 'revealFolder', projectPath: folder.dataset.folder });
      return;
    }
    const session = e.target.closest('[data-id]');
    if (session) {
      vscode.postMessage({ type: 'openTranscript', id: session.dataset.id });
    }
  });

  $projectItems.addEventListener('change', (e) => {
    const key = e.target.dataset?.key;
    if (key === undefined) return;
    // Ticking from the workspace view starts from the workspace's projects.
    const base = shownScope() === 'all' ? [] : shownKeys() ?? [];
    pick(e.target.checked ? [...base, key] : base.filter((k) => k !== key));
  });
  $projectQ.addEventListener('input', () => {
    menuQuery = $projectQ.value;
    renderMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$menu.hidden) {
      openMenu(false);
      $projectBtn.focus();
    }
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg?.type === 'state') {
      state = msg;
      range = msg.overview.range;
      // Picked projects that no longer exist drop out.
      if (msg.scope === 'pick') {
        projects = msg.overview.filter ?? [];
        save();
      }
      hideTip();
      render();
    }
  });

  render();
  vscode.postMessage({ type: 'ready', range, scope, projects, ...(sources ? { sources } : {}) });
})();
