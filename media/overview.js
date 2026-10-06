// Overview webview: renders the summary posted by OverviewPanel and sends user actions back.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let range = saved.range ?? 30;
  /** Keys of the projects shown; empty for all. */
  let projects = Array.isArray(saved.projects) ? saved.projects : [];
  let menuQuery = '';
  let state = null;

  const RANGES = [
    [7, '7 days'],
    [30, '30 days'],
    [90, '90 days'],
    [0, 'All time'],
  ];
  const PROJECTS_SHOWN = 10;

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
        <button class="chip" id="project-btn" aria-haspopup="true" aria-expanded="false"><i class="codicon codicon-folder"></i><span id="project-label">All projects</span><i class="codicon codicon-chevron-down"></i></button>
        <div class="menu" id="project-menu" hidden>
          <input id="project-q" type="text" placeholder="Find a project" spellcheck="false" aria-label="Find a project" />
          <div class="menu-items" id="project-items"></div>
          <div class="menu-foot"><button class="link" id="project-clear">Show all projects</button></div>
        </div>
      </div>
      <div class="selected" id="selected"></div>
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
  const $selected = document.getElementById('selected');

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
    return `
      <section class="kpis">
        ${kpi('Cost', money(t.cost), t.activeDays ? `${money(perDay)} per active day` : '', 'What these sessions would cost at Claude API prices, subagents included')}
        ${kpi('Sessions', count(t.sessions), t.sessions ? `${money(t.sessions ? t.cost / t.sessions : 0)} each on average` : '')}
        ${kpi('Prompts', count(t.prompts), t.sessions ? `${(t.prompts / t.sessions).toFixed(1)} per session` : '', 'Prompts you typed in these sessions')}
        ${kpi('Projects', count(t.projects), '')}
        ${kpi('Active days', count(t.activeDays), o.buckets.length && o.bucketDays === 1 ? `of ${o.buckets.length}` : '')}
      </section>`;
  }

  function renderChart(o) {
    const unit = o.bucketDays === 1 ? 'day' : 'week';
    const max = niceMax(Math.max(0, ...o.buckets.map((b) => b.cost)));
    const ticks = [max, max / 2, 0];
    const bars = o.buckets
      .map((b, i) => {
        const label = o.bucketDays === 1 ? longDay(b.start) : `Week of ${longDay(b.start)}`;
        const aria = `${label}: ${money(b.cost)}, ${plural(b.sessions, 'session')}`;
        return `<div class="bar-slot" data-i="${i}" tabindex="0" aria-label="${esc(aria)}"><div class="bar${b.cost ? '' : ' empty'}" data-h="${(b.cost / max) * 100}"></div></div>`;
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
        </div>
        <div class="chart">
          <div class="y-axis">${ticks.map((t) => `<span>${money(t).replace('.00', '')}</span>`).join('')}</div>
          <div class="plot">
            <div class="grid">${ticks.map(() => '<div></div>').join('')}</div>
            <div class="bars" role="img" aria-label="Cost per ${unit}">${bars}</div>
            <div class="x-axis">${xLabels}</div>
          </div>
        </div>
      </section>`;
  }

  function meter(fraction) {
    return `<div class="meter"><div data-w="${Math.max(0, Math.min(1, fraction)) * 100}"></div></div>`;
  }

  function renderProjects(o) {
    const shown = o.projects.slice(0, PROJECTS_SHOWN);
    const top = Math.max(...shown.map((p) => p.cost), 0) || 1;
    const rows = shown
      .map(
        (p) => `
        <tr>
          <td class="name"><span class="name-cell"><button class="link" data-only="${esc(p.key)}" title="${esc(p.path)}\nShow only this project"><span class="swatch" data-hue="${p.hue}"></span>${esc(p.name)}</button><button class="icon-btn small" data-folder="${esc(p.path)}" title="Open folder in a new window" aria-label="Open ${esc(p.name)} in a new window"><i class="codicon codicon-folder-opened"></i></button></span></td>
          <td class="num">${count(p.sessions)}</td>
          <td class="num">${count(p.prompts)}</td>
          <td class="num cost">${money(p.cost)}${meter(p.cost / top)}</td>
          <td class="num muted">${relative(p.lastTime)}</td>
        </tr>`,
      )
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
      .map(
        (m) => `
        <tr>
          <td class="name">${esc(m.model)}</td>
          <td class="num cost">${money(m.cost)}${meter(m.cost / total)}</td>
          <td class="num muted">${m.cost / total < 0.005 ? '&lt;1' : Math.round((m.cost / total) * 100)}%</td>
        </tr>`,
      )
      .join('');
    return `
      <section class="card">
        <div class="card-head"><h2>Models</h2><span class="muted">share of cost</span></div>
        ${rows ? `<table><thead><tr><th>Model</th><th class="num">Cost</th><th class="num">Share</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="muted pad">No priced usage in this range.</div>'}
      </section>`;
  }

  function renderTopSessions(o) {
    if (!o.topSessions.length) return '';
    const rows = o.topSessions
      .map(
        (s) => `
        <button class="session" data-id="${esc(s.id)}" title="Open transcript">
          <span class="session-title">${esc(s.title)}</span>
          <span class="session-meta">
            <span class="tag"><span class="swatch" data-hue="${s.hue}"></span>${esc(s.project)}</span>
            <span class="tag"><i class="codicon codicon-comment"></i>${count(s.prompts)}</span>
            <span class="tag muted">${relative(s.lastTime)}</span>
          </span>
          <span class="session-cost">${money(s.cost)}</span>
        </button>`,
      )
      .join('');
    return `
      <section class="card">
        <div class="card-head"><h2>Most expensive sessions</h2><span class="muted">cost in this range</span></div>
        <div class="sessions">${rows}</div>
      </section>`;
  }

  // ---------- project filter ----------

  const save = () => vscode.setState({ range, projects });

  function setProjects(next) {
    projects = next;
    save();
    vscode.postMessage({ type: 'setFilters', range, projects });
  }

  function renderFilter() {
    const all = state?.overview.allProjects ?? [];
    const byKey = new Map(all.map((p) => [p.key, p]));
    const chosen = projects.map((k) => byKey.get(k)).filter(Boolean);
    $projectLabel.textContent = !chosen.length ? 'All projects' : chosen.length === 1 ? chosen[0].name : `${chosen.length} projects`;
    $projectBtn.classList.toggle('on', chosen.length > 0);
    $selected.innerHTML = chosen
      .map(
        (p) =>
          `<span class="pill" title="${esc(p.path)}"><span class="swatch" data-hue="${p.hue}"></span>${esc(p.name)}<button class="pill-x" data-remove="${esc(p.key)}" title="Remove filter" aria-label="Remove ${esc(p.name)}"><i class="codicon codicon-close"></i></button></span>`,
      )
      .join('');
    paint($selected);
    renderMenu();
  }

  function renderMenu() {
    const all = state?.overview.allProjects ?? [];
    const q = menuQuery.trim().toLowerCase();
    const shown = q ? all.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)) : all;
    $projectItems.innerHTML = shown.length
      ? shown
          .map(
            (p) => `
          <label class="menu-item" title="${esc(p.path)}">
            <input type="checkbox" data-key="${esc(p.key)}"${projects.includes(p.key) ? ' checked' : ''} />
            <span class="swatch" data-hue="${p.hue}"></span>
            <span class="menu-name">${esc(p.name)}</span>
            <span class="muted menu-time">${relative(p.lastTime)}</span>
          </label>`,
          )
          .join('')
      : '<div class="muted menu-empty">No matching projects</div>';
    paint($projectItems);
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

  /** The page's CSP allows no inline style attributes, so sizes and colors are set through the DOM. */
  function paint(root) {
    for (const el of root.querySelectorAll('[data-h]')) el.style.height = `${el.dataset.h}%`;
    for (const el of root.querySelectorAll('[data-w]')) el.style.width = `${el.dataset.w}%`;
    for (const el of root.querySelectorAll('[data-x]')) el.style.left = `${el.dataset.x}%`;
    for (const el of root.querySelectorAll('[data-hue]')) el.style.setProperty('--hue', el.dataset.hue);
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
    const o = state.overview;
    const span = o.from === o.to ? longDay(o.to) : `${longDay(o.from)} – ${longDay(o.to)}`;
    $sub.innerHTML = `${esc(span)}${
      state.workspaceOnly ? ' · <button class="link" id="show-all" title="Include sessions from every project">current workspace only</button>' : ''
    }`;
    if (!o.totals.sessions) {
      $body.innerHTML = `<div class="empty-state muted">No sessions in this range${o.filter.length ? ' for the chosen projects' : ''}.</div>`;
      return;
    }
    $body.innerHTML = `
      ${renderKpis(o)}
      ${renderChart(o)}
      <div class="columns">
        ${renderProjects(o)}
        ${renderModels(o)}
      </div>
      ${renderTopSessions(o)}`;
    paint($body);
  }

  // ---------- tooltip ----------

  function showTip(slot) {
    const b = state?.overview.buckets[Number(slot.dataset.i)];
    if (!b) return;
    const o = state.overview;
    const label = o.bucketDays === 1 ? longDay(b.start) : `Week of ${longDay(b.start)}`;
    $tip.innerHTML = `<div class="tip-title">${esc(label)}</div><div class="tip-row"><span>Cost</span><b>${money(b.cost)}</b></div><div class="tip-row"><span>Sessions</span><b>${count(b.sessions)}</b></div>`;
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
    const rangeBtn = e.target.closest('[data-range]');
    if (rangeBtn) {
      range = Number(rangeBtn.dataset.range);
      save();
      render();
      vscode.postMessage({ type: 'setFilters', range, projects });
      return;
    }
    if (e.target.closest('#project-btn')) {
      openMenu($menu.hidden);
      return;
    }
    if (e.target.closest('#project-clear')) {
      openMenu(false);
      setProjects([]);
      return;
    }
    if (e.target.closest('#project-menu')) return;
    openMenu(false);
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      setProjects(projects.filter((k) => k !== remove.dataset.remove));
      return;
    }
    const only = e.target.closest('[data-only]');
    if (only) {
      // Clicking the only project shown goes back to all of them.
      setProjects(projects.length === 1 && projects[0] === only.dataset.only ? [] : [only.dataset.only]);
      return;
    }
    if (e.target.closest('#refresh')) {
      vscode.postMessage({ type: 'refresh' });
      return;
    }
    if (e.target.closest('#show-all')) {
      vscode.postMessage({ type: 'showAll' });
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
    setProjects(e.target.checked ? [...projects, key] : projects.filter((k) => k !== key));
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
      // Projects that no longer exist drop out of the filter.
      projects = msg.overview.filter;
      save();
      hideTip();
      render();
    }
  });

  render();
  vscode.postMessage({ type: 'ready', range, projects });
})();
