/* Dayplan UI: rendering, interactions and persistence. Depends on js/core.js. */
(function () {
  'use strict';

  const C = window.PlanCore;
  const STORAGE_KEY = 'dayplan.plans.v1';
  const PREFS_KEY = 'dayplan.prefs.v1';
  const VIEWS = ['today', 'board', 'calendar'];
  const SORTS = { manual: 'My order', deadline: 'Deadline', priority: 'Priority', newest: 'Newest' };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
  const truncate = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  const ICONS = {
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16v.5"/>',
    briefcase:
      '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 13h18"/>',
    calendarPlus: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M12 13v5M9.5 15.5h5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
    chevronRight: '<path d="M9 6l6 6-6 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    flame: '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5 1-8.5z"/>',
    halfCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
    play: '<path d="M8 5.5v13l10-6.5z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    // Signal bars: one, two or three lit for low, medium and high priority.
    priorityHigh: '<path d="M5 20v-5M12 20v-10M19 20V5"/>',
    priorityMedium: '<path d="M5 20v-5M12 20v-10"/><path class="dim" d="M19 20V5"/>',
    priorityLow: '<path d="M5 20v-5"/><path class="dim" d="M12 20v-10M19 20V5"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    steps: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    video: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="M15 10.5l6-3.5v10l-6-3.5z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
  };
  const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  const PRIORITY_ICONS = { high: 'priorityHigh', medium: 'priorityMedium', low: 'priorityLow' };
  const priorityChip = (priority) =>
    `<span class="chip prio-${priority}" title="${C.PRIORITY_LABELS[priority]} priority">${icon(PRIORITY_ICONS[priority])}${C.PRIORITY_LABELS[priority]}</span>`;

  /* -------------------------------------------------------------- storage */

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function removeStorage(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to remove */
    }
  }

  let loadProblem = '';
  // How often plans saved by an older version of Dayplan (which drops meeting
  // details) were read from storage, and how many of those a full download
  // from the account has since repaired. Kept outside `sync`, which doesn't
  // exist yet when the plans are first loaded.
  let olderDataLoads = 0;
  let olderDataPulled = 0;
  const olderIds = new Set(); // plans read from such a copy, until that download
  let restoredOnLoad = false; // the last load put back details an older version dropped

  // `previous`: the plans already shown, whose meeting details are kept if
  // the stored copy came from an older version.
  function loadPlans(previous = []) {
    restoredOnLoad = false;
    const raw = readStorage(STORAGE_KEY);
    if (!raw) return [];
    try {
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : data && Array.isArray(data.plans) ? data.plans : [];
      const older = list.filter(C.fromOlderVersion);
      if (older.length) {
        olderDataLoads += 1;
        const shown = new Map(previous.map((p) => [p.id, p]));
        for (const item of older) {
          if (typeof item.id === 'string') olderIds.add(item.id);
          if (C.isMeeting(shown.get(item.id))) restoredOnLoad = true;
        }
      }
      return C.importData(data, new Date(), previous);
    } catch (err) {
      // Never silently throw away someone's plans: keep the unreadable copy.
      console.error('Dayplan: stored plans could not be read.', err);
      writeStorage(`${STORAGE_KEY}.unreadable-${Date.now()}`, raw);
      loadProblem = 'Your saved plans could not be read. A backup copy was kept in browser storage.';
      return [];
    }
  }

  function savePlans() {
    if (!writeStorage(STORAGE_KEY, JSON.stringify(C.exportData(state.plans)))) {
      toast('Could not save. Browser storage may be full or disabled.');
    }
  }

  function loadPrefs() {
    const defaults = { view: 'today', sort: 'manual', theme: '' };
    try {
      const prefs = { ...defaults, ...JSON.parse(readStorage(PREFS_KEY) || '{}') };
      if (!VIEWS.includes(prefs.view)) prefs.view = defaults.view;
      if (!(prefs.sort in SORTS)) prefs.sort = defaults.sort;
      return prefs;
    } catch {
      return defaults;
    }
  }

  function savePrefs() {
    writeStorage(PREFS_KEY, JSON.stringify(state.prefs));
  }

  function detectWeekStart() {
    try {
      const locale = new Intl.Locale(navigator.language);
      const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo;
      if (info && info.firstDay) return info.firstDay % 7; // Intl uses 7 for Sunday
    } catch {
      /* older browsers: fall through */
    }
    return 1;
  }

  /* ---------------------------------------------------------------- state */

  const today = new Date();
  const state = {
    plans: loadPlans(),
    prefs: loadPrefs(),
    filters: { query: '', tag: '', priority: '', kind: '' },
    calendarMonth: new Date(today.getFullYear(), today.getMonth(), 1),
    selectedDay: C.toISODate(today),
    weekStart: detectWeekStart(),
    dragId: null,
    dropBeforeId: null,
    openSections: new Set(), // Today's expanded lists, kept open across refreshes
  };

  const findPlan = (id) => state.plans.find((p) => p.id === id);
  const visiblePlans = () => state.plans.filter((p) => C.matchesFilters(p, state.filters));
  const filtersActive = () =>
    Boolean(state.filters.query || state.filters.tag || state.filters.priority || state.filters.kind);

  // A plan brought back (undo, import) is a new change, newer than `over`.
  const restored = (plan, over = plan) => ({ ...plan, updatedAt: C.nextStamp(over.updatedAt) });
  // Undoing a delete must also be newer than the deletion, which was stamped
  // just after the plan's own time.
  const undeleted = (plan) => restored(plan, { updatedAt: C.nextStamp(plan.updatedAt) });

  function setPlans(plans) {
    const before = state.plans;
    state.plans = plans;
    savePlans();
    if (sync.user) trackChanges(before, plans);
    else trackDeletesWhileSignedOut(before, plans);
    render();
  }

  // Moves a plan into `status`, placing it first in that column.
  function placeAtTop(plans, id, status) {
    const top = C.sortPlans(plans.filter((p) => p.status === status && p.id !== id))[0];
    return C.movePlan(plans, id, status, top ? top.id : null);
  }

  function addPlan(fields) {
    const plan = C.createPlan(fields, state.plans);
    setPlans([plan, ...state.plans]);
    return plan;
  }

  function updatePlan(id, changes) {
    const now = new Date();
    setPlans(
      state.plans.map((p) => (p.id === id ? C.normalizePlan({ ...p, ...changes, updatedAt: C.nextStamp(p.updatedAt, now) }, now) : p))
    );
  }

  function changeStatus(id, status, origin) {
    const plan = findPlan(id);
    if (!plan || plan.status === status) return;
    const point = origin ? centerOf(origin) : null;
    setPlans(placeAtTop(state.plans, id, status));
    if (status === 'done') {
      celebrate(point);
      toast(`Done: “${truncate(plan.title)}”`, { action: 'Undo', onAction: () => changeStatus(id, plan.status) });
    }
  }

  function deletePlan(id) {
    const index = state.plans.findIndex((p) => p.id === id);
    if (index < 0) return;
    const plan = state.plans[index];
    setPlans(state.plans.filter((p) => p.id !== id));
    toast(`Deleted “${truncate(plan.title)}”`, {
      action: 'Undo',
      onAction: () => {
        if (findPlan(id)) return;
        const plans = [...state.plans];
        plans.splice(Math.min(index, plans.length), 0, undeleted(plan));
        setPlans(plans);
      },
    });
  }

  function setView(view) {
    if (!VIEWS.includes(view)) return;
    state.prefs.view = view;
    savePrefs();
    render();
    window.scrollTo({ top: 0 });
  }

  function setTagFilter(tag) {
    state.filters.tag = state.filters.tag === tag ? '' : tag;
    render();
  }

  /* -------------------------------------------------------------- helpers */

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const TIME_UNITS = [
    ['year', 31536000000],
    ['month', 2592000000],
    ['week', 604800000],
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000],
  ];

  function timeAgo(iso) {
    const diff = new Date(iso).getTime() - Date.now();
    for (const [unit, ms] of TIME_UNITS) {
      if (Math.abs(diff) >= ms) return relativeFormat.format(Math.round(diff / ms), unit);
    }
    return 'just now';
  }

  function duration(ms) {
    for (const [unit, size] of TIME_UNITS.slice(3)) {
      if (ms >= size) {
        const n = Math.round(ms / size);
        return `${n} ${unit}${n === 1 ? '' : 's'}`;
      }
    }
    return 'under a minute';
  }

  function greeting(now) {
    const h = now.getHours();
    if (h < 5) return 'Burning the midnight oil';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 22) return 'Good evening';
    return 'Winding down';
  }

  /* ------------------------------------------------------------ rendering */

  function render() {
    const restore = focusMemo();
    const view = state.prefs.view;
    document.body.dataset.view = view;
    for (const tab of $$('.view-tab')) {
      if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    renderHeading(view);
    renderSidebarTags();
    renderFilters();
    const html = view === 'board' ? boardHTML() : view === 'calendar' ? calendarHTML() : todayHTML();
    // Replace the page only when something changed: the once-a-minute refresh
    // and syncs with no news then never swallow a tap or move the focus.
    if (html !== state.viewHTML) {
      if (state.viewHTML && withoutCountdowns(html) === withoutCountdowns(state.viewHTML)) {
        // Only "Starts in 12 minutes" moved on: update those words in place.
        const next = document.createElement('template');
        next.innerHTML = html;
        const fresh = next.content.querySelectorAll('[data-countdown]');
        $$('#view [data-countdown]').forEach((el, i) => fresh[i] && setText(el, fresh[i].textContent));
      } else {
        $('#view').innerHTML = html;
      }
      state.viewHTML = html;
    }
    updateBadges();
    restore();
  }

  const withoutCountdowns = (html) => html.replace(/(<span data-countdown>)[^<]*/g, '$1');

  // A selector for the same control after a re-render, e.g. the Join link of
  // a given plan, or the "+" of the Done column.
  function controlKey(el) {
    const attrs = ['data-action', 'data-date', 'data-status', 'data-kind', 'data-view', 'data-tag']
      .filter((a) => el.hasAttribute(a))
      .map((a) => `[${a}="${CSS.escape(el.getAttribute(a))}"]`)
      .join('');
    const host = el.closest('[data-id]');
    const id = host ? `[data-id="${CSS.escape(host.dataset.id)}"]` : '';
    const tag = el.tagName.toLowerCase();
    const section = el.parentElement && el.parentElement.dataset.section;
    if (tag === 'summary' && section) return `[data-section="${CSS.escape(section)}"] > summary`;
    if (!attrs && !id) return '';
    return host === el ? `${tag}${id}${attrs}` : `${id ? `${id} ` : ''}${tag}${attrs}`;
  }

  // Keeps keyboard focus on the same control after a re-render.
  function focusMemo() {
    const view = $('#view');
    const active = document.activeElement;
    if (!active || active === document.body || !view.contains(active)) return () => {};
    const key = controlKey(active);
    // The same plan can appear twice (e.g. "Focus now" and its section): keep the same one.
    const index = key ? $$(key, view).indexOf(active) : -1;
    const section = active.closest('[data-section]');
    const sectionKey = section ? `[data-section="${CSS.escape(section.dataset.section)}"]` : '';
    const row = section ? $$('.card', section).indexOf(active.closest('.card')) : -1;
    return () => {
      if (active.isConnected) return; // nothing was replaced
      const focused = (el) => {
        if (!el) return false;
        el.focus({ preventScroll: true });
        return document.activeElement === el;
      };
      if (key) {
        const matches = $$(key, view);
        if (focused(matches[index]) || matches.some(focused)) return;
      }
      // The plan left its list (e.g. ticked off under Past meetings): stay in that list.
      const list = sectionKey && $(sectionKey, view);
      if (!list) return;
      const cards = $$('.card', list);
      const next = cards[Math.min(Math.max(row, 0), cards.length - 1)];
      if (!focused(next && next.querySelector('.status-btn'))) focused($('summary', list));
    };
  }

  function updateBadges() {
    const stats = C.computeStats(state.plans);
    const urgent = stats.overdue + stats.dueToday;
    const badge = $('[data-badge="today"]');
    badge.hidden = urgent === 0;
    badge.textContent = urgent;
    badge.classList.toggle('alert', stats.overdue > 0);
    badge.title = `${stats.overdue} overdue, ${stats.dueToday} due today`;
    document.title = urgent ? `(${urgent}) Dayplan` : 'Dayplan';
  }

  // Replaces a box's content only when it changed, keeping keyboard focus on
  // the same control (matched by its data attributes).
  const shownHTML = new WeakMap();

  function setHTML(box, html) {
    if (shownHTML.get(box) === html) return;
    const active = document.activeElement;
    let key = null;
    if (active && box.contains(active)) {
      const attr = ['data-tag', 'data-filter', 'data-action'].find((a) => active.hasAttribute(a));
      if (attr) key = `[${attr}="${CSS.escape(active.getAttribute(attr))}"]`;
    }
    box.innerHTML = html;
    shownHTML.set(box, html);
    if (key) box.querySelector(key)?.focus({ preventScroll: true });
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  const VIEW_TITLES = { today: 'Today', board: 'Board', calendar: 'Calendar' };

  function renderHeading(view) {
    const now = new Date();
    let subtitle = '';
    if (view === 'today') {
      subtitle = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    } else if (view === 'board') {
      const stats = C.computeStats(state.plans, now);
      subtitle = state.plans.length
        ? `${stats.todo} to do · ${stats.in_progress} in progress · ${stats.done} done`
        : 'Your plans by status';
    } else {
      const month = state.calendarMonth;
      const prefix = C.toISODate(month).slice(0, 7);
      const inMonth = state.plans.filter((p) => p.dueDate.startsWith(prefix));
      const meetings = inMonth.filter(C.isMeeting).length;
      const due = inMonth.length - meetings;
      const name = month.toLocaleDateString(undefined, { month: 'long' });
      const plansText = `${due} ${due === 1 ? 'plan' : 'plans'} due`;
      const meetingsText = `${meetings} ${meetings === 1 ? 'meeting' : 'meetings'}`;
      if (due && meetings) subtitle = `${plansText} and ${meetingsText} in ${name}`;
      else if (meetings) subtitle = `${meetingsText} in ${name}`;
      else if (due) subtitle = `${plansText} in ${name}`;
      else subtitle = `No plans due in ${name}`;
    }
    setText($('#page-title'), VIEW_TITLES[view]);
    setText($('#page-subtitle'), subtitle);
  }

  function renderSidebarTags() {
    const tags = C.allTags(state.plans);
    $('#sidebar-tags-section').hidden = !tags.length;
    setHTML(
      $('#sidebar-tags'),
      tags
        .map((t) => {
          const on = t.name === state.filters.tag;
          return `<button type="button" class="sidebar-tag" data-tag="${esc(t.name)}" aria-pressed="${on}" title="Show only #${esc(t.name)}">
            <span class="tag-hash" aria-hidden="true">#</span><span class="tag-name">${esc(t.name)}</span><span class="tag-count">${t.count}</span>
          </button>`;
        })
        .join('')
    );
  }

  function renderFilters() {
    const box = $('#filters');
    if (!state.plans.length) {
      setHTML(box, '');
      return;
    }
    const { tag, priority } = state.filters;
    const tags = C.allTags(state.plans);
    const pill = (value, label, count) => `
      <button type="button" class="pill${value === tag ? ' active' : ''}" data-action="filter-tag" data-tag="${esc(value)}" aria-pressed="${value === tag}">
        ${label}${count ? ` <span class="pill-count">${count}</span>` : ''}
      </button>`;
    const option = (value, label, current) =>
      `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`;

    setHTML(box, `
      ${
        tags.length
          ? `<div class="filter-chips" role="group" aria-label="Filter by tag">
              ${pill('', 'All tags') + tags.map((t) => pill(t.name, `#${esc(t.name)}`, t.count)).join('')}
            </div>`
          : ''
      }
      <div class="filter-controls">
        ${
          state.plans.some(C.isMeeting) || state.filters.kind
            ? `<label class="select">
                <span class="sr-only">Show plans or meetings</span>
                <select data-filter="kind">
                  ${option('', 'Plans and meetings', state.filters.kind)}
                  ${option('meeting', 'Meetings only', state.filters.kind)}
                  ${option('plan', 'Plans only', state.filters.kind)}
                </select>
              </label>`
            : ''
        }
        <label class="select">
          <span class="sr-only">Filter by priority</span>
          <select data-filter="priority">
            ${option('', 'Any priority', priority)}
            ${C.PRIORITIES.slice().reverse().map((p) => option(p, `${C.PRIORITY_LABELS[p]} priority`, priority)).join('')}
          </select>
        </label>
        ${
          state.prefs.view === 'board'
            ? `<label class="select">
                <span class="sr-only">Sort cards by</span>
                <select data-filter="sort">
                  ${Object.entries(SORTS).map(([v, l]) => option(v, `Sort: ${l}`, state.prefs.sort)).join('')}
                </select>
              </label>`
            : ''
        }
        ${filtersActive() ? `<button type="button" class="pill" data-action="clear-filters">${icon('x')} Clear filters</button>` : ''}
      </div>`);
  }

  function statusButton(plan) {
    const next = C.STATUS_LABELS[C.nextStatus(plan.status, plan.kind)].toLowerCase();
    const label = `${C.STATUS_LABELS[plan.status]}. Mark as ${next}`;
    return `<button type="button" class="status-btn s-${plan.status}" data-action="cycle" aria-label="${esc(label)}" title="${esc(label)}">${icon('check')}</button>`;
  }

  function metaHTML(plan, now) {
    const due = C.dueInfo(plan, now);
    const progress = C.checklistProgress(plan);
    const parts = [];
    if (C.isMeeting(plan)) {
      // A meeting always says when it is, even if that's not set yet.
      const title = due.full && !plan.dueTime ? `${due.full} (time not set)` : due.full;
      const label = due.state === 'now' ? `<span data-countdown>${esc(due.label)}</span>` : esc(due.label);
      parts.push(`<span class="chip due due-${due.state}" title="${esc(title)}">${icon('video')}${label}</span>`);
      if (plan.company && !plan.title.toLowerCase().includes(plan.company.toLowerCase())) {
        parts.push(
          `<span class="chip company" title="${esc(plan.company)}">${icon('briefcase')}<span class="chip-text">${esc(plan.company)}</span></span>`
        );
      }
    } else if (due.state !== 'none') {
      parts.push(
        `<span class="chip due due-${due.state}" title="${esc(due.full)}">${icon(due.state === 'overdue' ? 'alert' : 'clock')}${esc(due.label)}</span>`
      );
    }
    // Medium is the default, so only the exceptions are pointed out.
    if (plan.priority !== 'medium') parts.push(priorityChip(plan.priority));
    if (progress.total) {
      const complete = progress.done === progress.total ? ' complete' : '';
      parts.push(`<span class="chip steps${complete}" title="Steps done">${icon('steps')}${progress.done}/${progress.total}</span>`);
    }
    for (const t of plan.tags) {
      parts.push(
        `<button type="button" class="chip tag" data-action="filter-tag" data-tag="${esc(t)}" title="Show only #${esc(t)}">#${esc(t)}</button>`
      );
    }
    return parts.length ? `<div class="card-meta">${parts.join('')}</div>` : '';
  }

  // A link that opens in a new tab. Only ever an http(s) address: links are
  // checked again here, whatever was stored.
  function linkButton(url, { action, label, text, iconName, kind = 'ghost', size = 'small' }) {
    const href = C.cleanUrl(url);
    if (!href) return '';
    return `<a class="btn ${size} ${kind}" href="${esc(href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"
      draggable="false" data-action="${action}" title="Opens ${esc(C.linkHost(href))} in a new tab" aria-label="${esc(label)}">${icon(iconName)}${text}</a>`;
  }

  function joinButton(plan, due, size = 'small') {
    if (plan.status === 'done') return '';
    const who = plan.company || plan.title;
    return linkButton(plan.meetingUrl, {
      action: 'open-meeting',
      label: `Join the meeting with ${who} (opens in a new tab)`,
      text: 'Join',
      iconName: 'video',
      kind: due.state === 'now' || size !== 'small' ? 'primary' : 'ghost',
      size,
    });
  }

  function jobButton(plan, size = 'small') {
    return linkButton(plan.jobUrl, {
      action: 'open-job',
      label: `Job description for ${plan.company || plan.title} (opens in a new tab)`,
      text: 'Job description',
      iconName: 'external',
      size,
    });
  }

  function meetingLinksHTML(plan, due) {
    const links = joinButton(plan, due) + jobButton(plan);
    return links ? `<div class="card-links">${links}</div>` : '';
  }

  function cardHTML(plan, { now = new Date(), draggable = false, row = false } = {}) {
    const progress = C.checklistProgress(plan);
    const meeting = C.isMeeting(plan);
    const due = meeting ? C.dueInfo(plan, now) : null;
    const status = row && plan.status !== 'todo'
      ? `<span class="status-tag s-${plan.status}">${C.STATUS_LABELS[plan.status]}</span>`
      : '';
    const label = meeting
      ? `${plan.title}, meeting, ${due.full || 'date not set'}, ${C.STATUS_LABELS[plan.status]}`
      : `${plan.title}, ${C.STATUS_LABELS[plan.status]}`;
    return `
      <article class="card${row ? ' row' : ''}${meeting ? ' is-meeting' : ''} p-${plan.priority} is-${plan.status}" data-id="${esc(plan.id)}" data-action="edit"
        tabindex="0" ${draggable ? 'draggable="true"' : ''} aria-label="${esc(label)}">
        ${statusButton(plan)}
        <div class="card-main">
          <h3 class="card-title">${esc(plan.title)}</h3>
          ${plan.description ? `<p class="card-desc">${esc(plan.description)}</p>` : ''}
          ${metaHTML(plan, now)}
          ${meeting ? meetingLinksHTML(plan, due) : ''}
          ${progress.total ? `<div class="progress" aria-hidden="true"><span style="width:${progress.pct}%"></span></div>` : ''}
        </div>
        ${status}
      </article>`;
  }

  function emptyStateHTML() {
    return `
      <section class="empty">
        <svg class="empty-art" viewBox="0 0 160 120" aria-hidden="true">
          <rect x="22" y="18" width="116" height="88" rx="14" class="ea-card"/>
          <rect x="38" y="38" width="14" height="14" rx="5" class="ea-box done"/>
          <path d="M41.5 45l3 3 5-6" class="ea-check"/>
          <rect x="60" y="41" width="56" height="8" rx="4" class="ea-line"/>
          <rect x="38" y="62" width="14" height="14" rx="5" class="ea-box"/>
          <rect x="60" y="65" width="42" height="8" rx="4" class="ea-line"/>
          <circle cx="132" cy="22" r="14" class="ea-sun"/>
        </svg>
        <h2>Plan your day, one step at a time</h2>
        <p>Type a plan in the box above, for example <em>“Call the bank tomorrow 10am #errands”</em>.
           Give it a deadline, break it into steps and move it from <strong>To do</strong> to <strong>Done</strong>.</p>
        <div class="empty-actions">
          <button type="button" class="btn primary" data-action="new">${icon('plus')} Create a plan</button>
          <button type="button" class="btn ghost" data-action="new" data-kind="meeting">${icon('video')} Add a meeting</button>
          <button type="button" class="btn ghost" data-action="samples">${icon('sparkle')} Show me with sample plans</button>
        </div>
      </section>`;
  }

  function noMatchesHTML() {
    return `
      <section class="empty small">
        <h2>No plans match</h2>
        <p>Nothing fits the current search or filters.</p>
        <button type="button" class="btn ghost" data-action="clear-filters">Clear filters</button>
      </section>`;
  }

  /* ---- Today */

  function todayHTML() {
    if (!state.plans.length) return emptyStateHTML();
    const now = new Date();
    const plans = visiblePlans();
    const stats = C.computeStats(state.plans, now);
    const groups = C.groupForToday(plans, now);
    const focus = C.nextUp(plans, now);

    const remaining = stats.todayTotal - stats.doneToday;
    let summary;
    if (!stats.todayTotal) summary = 'Nothing is due today. A good day to get ahead.';
    else if (!remaining) summary = 'Everything due today is done. Nice work!';
    else summary = `${remaining} ${remaining === 1 ? 'plan' : 'plans'} left for today.`;
    if (stats.overdue && remaining) summary += ` ${stats.overdue} overdue ${stats.overdue === 1 ? 'needs' : 'need'} attention.`;
    // The same meeting as the Focus card when one is about to start or running.
    const nextMeeting =
      focus && C.isMeeting(focus) && C.dueInfo(focus, now).state === 'now'
        ? focus
        : groups.today.find((p) => C.isMeeting(p) && p.dueTime && ['now', 'today'].includes(C.dueInfo(p, now).state));
    let meetingSentence = '';
    if (nextMeeting) {
      const due = C.dueInfo(nextMeeting, now);
      const name = truncate(nextMeeting.company || nextMeeting.title, 40);
      if (due.state === 'now' && due.minutes > 0) {
        meetingSentence = `Your meeting with ${name} starts in ${due.minutes} ${due.minutes === 1 ? 'minute' : 'minutes'}.`;
      } else if (due.state === 'now') {
        meetingSentence = `Your meeting with ${name} is happening now.`;
      } else {
        meetingSentence = `Next meeting: ${name} at ${C.formatTime(nextMeeting.dueTime)}.`;
      }
    }

    const circumference = 2 * Math.PI * 52;
    const ringOffset = circumference * (1 - stats.todayPct / 100);
    const kpi = (label, value, iconName, kind = '') => `
      <div class="kpi${kind ? ` ${kind}` : ''}">
        <span class="kpi-label">${icon(iconName)}${label}</span>
        <strong class="kpi-value">${value}</strong>
      </div>`;

    const section = (key, title, list) =>
      list.length
        ? `<section class="today-section ${key}" aria-label="${title}">
            <h2 class="section-title">${title}<span class="count">${list.length}</span></h2>
            <div class="row-list">${list.map((p) => cardHTML(p, { now, row: true })).join('')}</div>
          </section>`
        : '';

    const sections = [
      section('overdue', 'Overdue', groups.overdue),
      section('due-today', groups.today.some(C.isMeeting) ? 'Today' : 'Due today', groups.today),
      section('doing', 'In progress', groups.inProgress),
      section('upcoming', 'Next 7 days', groups.upcoming),
    ].join('');

    const pastMeetings = groups.pastMeetings.length
      ? `<details class="today-section done-today past-meetings" data-section="past"${state.openSections.has('past') ? ' open' : ''}>
          <summary class="section-title">Past meetings<span class="count">${groups.pastMeetings.length}</span></summary>
          <p class="hint">Tick off each meeting once you've followed up, for example after sending a thank-you note.</p>
          <div class="row-list">${groups.pastMeetings.map((p) => cardHTML(p, { now, row: true })).join('')}</div>
        </details>`
      : '';

    const doneToday = groups.doneToday.length
      ? `<details class="today-section done-today" data-section="done"${state.openSections.has('done') ? ' open' : ''}>
          <summary class="section-title">Finished today<span class="count">${groups.doneToday.length}</span></summary>
          <div class="row-list">${groups.doneToday.map((p) => cardHTML(p, { now, row: true })).join('')}</div>
        </details>`
      : '';

    const later = groups.later.length
      ? `<p class="later-note">${groups.later.length} more ${groups.later.length === 1 ? 'plan is' : 'plans are'} further out or ${groups.later.length === 1 ? 'has' : 'have'} no deadline.
           <button type="button" class="link" data-action="go" data-view="board">See them on the board</button></p>`
      : '';

    return `
      <section class="hero" aria-label="Today at a glance">
        <div class="hero-card">
          <div class="hero-text">
            <p class="eyebrow hero-date">${esc(now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}</p>
            <h2 class="hero-title">${greeting(now)}</h2>
            <p class="hero-sub">${esc(summary)}${meetingSentence ? ` <span data-countdown>${esc(meetingSentence)}</span>` : ''}</p>
            ${
              stats.streak
                ? `<p class="streak" title="Days in a row with at least one plan finished">${icon('flame')}${stats.streak}-day streak</p>`
                : ''
            }
          </div>
          <div class="ring" role="img" aria-label="${stats.doneToday} of ${stats.todayTotal} plans for today done">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle class="ring-track" cx="60" cy="60" r="52"/>
              <circle class="ring-value${stats.todayTotal && !remaining ? ' complete' : ''}" cx="60" cy="60" r="52"
                stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${ringOffset.toFixed(1)}"/>
            </svg>
            <div class="ring-label">
              <strong>${stats.todayTotal ? `${stats.doneToday}/${stats.todayTotal}` : icon('sparkle')}</strong>
              <span>${stats.todayTotal ? 'done today' : 'clear day'}</span>
            </div>
          </div>
        </div>
        <div class="kpis">
          ${kpi('Due today', stats.dueToday, 'clock')}
          ${kpi('Overdue', stats.overdue, 'alert', stats.overdue ? 'warn' : '')}
          ${kpi('In progress', stats.in_progress, 'halfCircle')}
          ${kpi('Done this week', stats.doneThisWeek, 'check', 'good')}
        </div>
      </section>
      ${focus ? focusHTML(focus, now) : ''}
      ${
        sections || pastMeetings || doneToday || later
          ? `${sections}${pastMeetings}${doneToday}${later}`
          : filtersActive()
            ? noMatchesHTML()
            : ''
      }`;
  }

  function focusHTML(plan, now) {
    if (C.isMeeting(plan)) return meetingFocusHTML(plan, now);
    const start =
      plan.status === 'todo'
        ? `<button type="button" class="btn ghost" data-action="set-status" data-status="in_progress">${icon('play')} Start</button>`
        : '';
    return `
      <section class="focus" data-id="${esc(plan.id)}" aria-label="Focus now">
        <div class="focus-text">
          <p class="eyebrow">${icon('target')} Focus now</p>
          <h2 class="focus-title">${esc(plan.title)}</h2>
          ${metaHTML(plan, now)}
        </div>
        <div class="focus-actions">
          ${start}
          <button type="button" class="btn primary" data-action="set-status" data-status="done">${icon('check')} Mark done</button>
          <button type="button" class="btn ghost" data-action="edit">Open</button>
        </div>
      </section>`;
  }

  function meetingFocusHTML(plan, now) {
    const due = C.dueInfo(plan, now);
    const join = joinButton(plan, due, '');
    const happening = due.state === 'now' && due.minutes <= 0;
    return `
      <section class="focus is-meeting" data-id="${esc(plan.id)}" aria-label="${happening ? 'Happening now' : 'Next meeting'}">
        <div class="focus-text">
          <p class="eyebrow">${icon('video')} ${happening ? 'Happening now' : 'Next meeting'}</p>
          <h2 class="focus-title">${esc(plan.title)}</h2>
          ${metaHTML(plan, now)}
        </div>
        <div class="focus-actions">
          ${join}
          ${jobButton(plan, '')}
          <button type="button" class="btn ${join ? 'ghost' : 'primary'}" data-action="set-status" data-status="done">${icon('check')} Mark done</button>
          <button type="button" class="btn ghost" data-action="edit">Open</button>
        </div>
      </section>`;
  }

  /* ---- Board */

  function boardHTML() {
    const now = new Date();
    const plans = visiblePlans();
    const emptyText = {
      todo: 'Nothing waiting. Add a plan above.',
      in_progress: 'Drag a plan here, or press its circle, when you start it.',
      done: 'Finished plans land here.',
    };
    const columns = C.STATUSES.map((status) => {
      const items = C.sortPlans(
        plans.filter((p) => p.status === status),
        state.prefs.sort
      );
      const label = C.STATUS_LABELS[status];
      return `
        <section class="column col-${status}" aria-label="${label}">
          <header class="column-head">
            <span class="column-dot s-${status}" aria-hidden="true"></span>
            <h2>${label}</h2>
            <span class="count">${items.length}</span>
            <button type="button" class="icon-btn small" data-action="new" data-status="${status}" title="Add a plan to ${label}" aria-label="Add a plan to ${label}">${icon('plus')}</button>
          </header>
          <div class="column-body" data-drop-status="${status}">
            ${items.map((p) => cardHTML(p, { now, draggable: true })).join('') || `<p class="column-empty">${filtersActive() ? 'No matching plans.' : emptyText[status]}</p>`}
          </div>
        </section>`;
    });
    return `<div class="board">${columns.join('')}</div>`;
  }

  /* ---- Calendar */

  function calendarHTML() {
    const now = new Date();
    const todayKey = C.toISODate(now);
    const month = state.calendarMonth;
    const days = C.monthGrid(month.getFullYear(), month.getMonth(), state.weekStart);
    const plans = visiblePlans();

    const byDate = new Map();
    for (const p of C.sortPlans(plans.filter((plan) => plan.dueDate), 'deadline')) {
      if (!byDate.has(p.dueDate)) byDate.set(p.dueDate, []);
      byDate.get(p.dueDate).push(p);
    }
    const unscheduled = C.sortPlans(plans.filter((p) => !p.dueDate && p.status !== 'done'));
    const chip = (p) => {
      const at = p.dueTime ? ` at ${C.formatTime(p.dueTime)}` : '';
      if (!C.isMeeting(p)) {
        return `
          <button type="button" class="cal-chip s-${p.status} p-${p.priority}" data-action="edit" data-id="${esc(p.id)}" draggable="true"
            title="${esc(p.title + at)}">
            <span class="cal-title">${esc(p.title)}</span>
          </button>`;
      }
      // Meetings read "2:30 PM Acme".
      return `
        <button type="button" class="cal-chip is-meeting s-${p.status} p-${p.priority}" data-action="edit" data-id="${esc(p.id)}" draggable="true"
          title="${esc(`${p.title}${at}${p.company ? ` · ${p.company}` : ''}`)}">
          <span class="sr-only">Meeting: </span>${p.dueTime ? `<span class="cal-time">${esc(C.formatShortTime(p.dueTime))}</span>` : ''}<span class="cal-title">${esc(p.company || p.title)}</span>
        </button>`;
    };
    const countLabel = (items) => {
      const meetings = items.filter(C.isMeeting).length;
      const others = items.length - meetings;
      return [
        others ? `${others} ${others === 1 ? 'plan' : 'plans'}` : '',
        meetings ? `${meetings} ${meetings === 1 ? 'meeting' : 'meetings'}` : '',
      ]
        .filter(Boolean)
        .join(', ');
    };

    const headers = days
      .slice(0, 7)
      .map(
        (d) => `<div class="cal-weekday" role="columnheader" aria-label="${esc(d.toLocaleDateString(undefined, { weekday: 'long' }))}">
          <span class="wd-long">${esc(d.toLocaleDateString(undefined, { weekday: 'short' }))}</span>
          <span class="wd-short">${esc(d.toLocaleDateString(undefined, { weekday: 'narrow' }))}</span>
        </div>`
      )
      .join('');

    const weeks = [];
    for (let w = 0; w < 6; w += 1) {
      const cells = days.slice(w * 7, w * 7 + 7).map((d) => {
        const key = C.toISODate(d);
        const items = byDate.get(key) || [];
        const open = items.filter((p) => p.status !== 'done');
        const classes = ['cal-day'];
        if (d.getMonth() !== month.getMonth()) classes.push('outside');
        if (key === todayKey) classes.push('today');
        if (key === state.selectedDay) classes.push('selected');
        if (key < todayKey) classes.push('past');
        if (open.some((p) => C.dueInfo(p, now).state === 'overdue')) classes.push('has-overdue');
        const label = `${d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}${items.length ? `, ${countLabel(items)}` : ''}`;
        return `
          <div class="${classes.join(' ')}" role="gridcell" data-action="select-day" data-date="${key}" data-drop-date="${key}">
            <button type="button" class="cal-num" data-action="select-day" data-date="${key}" aria-label="${esc(label)}"
              ${key === state.selectedDay ? 'aria-pressed="true"' : 'aria-pressed="false"'}>${d.getDate()}</button>
            <div class="cal-items">
              ${items.slice(0, 3).map(chip).join('')}
              ${items.length > 3 ? `<span class="cal-more">+${items.length - 3} more</span>` : ''}
            </div>
            ${
              items.length
                ? `<span class="cal-dots" aria-hidden="true">${items
                    .slice(0, 4)
                    .map((p) => `<i class="s-${p.status}${C.isMeeting(p) ? ' is-meeting' : ''}"></i>`)
                    .join('')}</span>`
                : ''
            }
          </div>`;
      });
      weeks.push(`<div class="cal-week" role="row">${cells.join('')}</div>`);
    }

    return `
      <div class="calendar-layout">
        <section class="calendar" aria-label="Calendar">
          <header class="cal-head">
            <h2>${esc(month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</h2>
            <div class="cal-nav">
              <button type="button" class="icon-btn" data-action="cal-prev" aria-label="Previous month" title="Previous month ([)">${icon('chevronLeft')}</button>
              <button type="button" class="btn ghost small" data-action="cal-today">Today</button>
              <button type="button" class="icon-btn" data-action="cal-next" aria-label="Next month" title="Next month (])">${icon('chevronRight')}</button>
            </div>
          </header>
          <div class="cal-grid" role="grid" aria-label="${esc(month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}">
            <div class="cal-week cal-weekdays" role="row">${headers}</div>
            ${weeks.join('')}
          </div>
          <p class="hint">Tip: drag a plan onto another day to reschedule it. Double-click a day to add a plan.</p>
        </section>

        <aside class="cal-side">
          ${dayPanelHTML(byDate.get(state.selectedDay) || [], now)}
          <section class="unscheduled" data-drop-date="" aria-label="Plans without a deadline">
            <header class="side-head">
              <h3>No deadline <span class="count">${unscheduled.length}</span></h3>
            </header>
            <p class="hint">Drag one onto a day to schedule it. Drop a scheduled plan here to clear its deadline.</p>
            <div class="chip-list">${unscheduled.map(chip).join('') || '<p class="muted">Every open plan has a deadline.</p>'}</div>
          </section>
        </aside>
      </div>`;
  }

  function dayPanelHTML(plans, now) {
    const day = C.parseISODate(state.selectedDay) || C.startOfDay(now);
    const label = day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    return `
      <section class="day-panel" aria-label="Plans on ${esc(label)}">
        <header class="side-head">
          <h3>${esc(label)}</h3>
          <div class="side-actions">
            <button type="button" class="btn primary small" data-action="new" data-date="${state.selectedDay}" aria-label="Add a plan on ${esc(label)}">${icon('plus')} Plan</button>
            <button type="button" class="btn ghost small" data-action="new" data-kind="meeting" data-date="${state.selectedDay}" aria-label="Add a meeting on ${esc(label)}">${icon('video')} Meeting</button>
          </div>
        </header>
        ${
          plans.length
            ? `<div class="row-list">${plans.map((p) => cardHTML(p, { now, row: true })).join('')}</div>`
            : '<p class="muted">Nothing planned for this day yet.</p>'
        }
      </section>`;
  }

  // Selecting a day only touches the grid highlight and the side panel, so
  // the cells stay in place (and a double-click on them still registers).
  function selectDay(date) {
    const d = C.parseISODate(date);
    if (!d) return;
    state.selectedDay = date;
    state.viewHTML = null; // the calendar is updated in place below
    const month = state.calendarMonth;
    if (d.getMonth() !== month.getMonth() || d.getFullYear() !== month.getFullYear()) {
      state.calendarMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      render();
      return;
    }
    for (const cell of $$('#view .cal-day')) {
      const on = cell.dataset.date === date;
      cell.classList.toggle('selected', on);
      cell.querySelector('.cal-num').setAttribute('aria-pressed', String(on));
    }
    const plans = C.sortPlans(
      visiblePlans().filter((p) => p.dueDate === date),
      'deadline'
    );
    $('#view .day-panel').outerHTML = dayPanelHTML(plans, new Date());
  }

  function shiftMonth(delta) {
    const m = state.calendarMonth;
    state.calendarMonth = new Date(m.getFullYear(), m.getMonth() + delta, 1);
    render();
  }

  /* --------------------------------------------------------- drag & drop */

  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  function clearDropTargets() {
    for (const el of $$('.drop-target')) el.classList.remove('drop-target');
    indicator.remove();
  }

  function endDrag() {
    state.dragId = null;
    state.dropBeforeId = null;
    clearDropTargets();
    for (const el of $$('.dragging')) el.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    if (state.renderAfterDrag) {
      // Changes from another device arrived mid-drag; show them now.
      state.renderAfterDrag = false;
      render();
    }
  }

  function setupDragAndDrop() {
    const view = $('#view');

    view.addEventListener('dragstart', (e) => {
      const item = e.target instanceof Element && e.target.closest('[draggable="true"][data-id]');
      if (!item) return;
      state.dragId = item.dataset.id;
      // dragend still reaches the card itself if it was replaced meanwhile.
      item.addEventListener('dragend', endDrag, { once: true });
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.dataset.id);
      requestAnimationFrame(() => {
        item.classList.add('dragging');
        document.body.classList.add('is-dragging');
      });
    });

    view.addEventListener('dragover', (e) => {
      if (!state.dragId) return;
      const zone = e.target.closest('[data-drop-status], [data-drop-date]');
      if (!zone) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!zone.classList.contains('drop-target')) {
        clearDropTargets();
        zone.classList.add('drop-target');
      }
      if (zone.dataset.dropStatus && state.prefs.sort === 'manual') {
        const cards = $$('.card:not(.dragging)', zone);
        const before = cards.find((card) => {
          const r = card.getBoundingClientRect();
          return e.clientY < r.top + r.height / 2;
        });
        state.dropBeforeId = before ? before.dataset.id : null;
        if (before) zone.insertBefore(indicator, before);
        else zone.appendChild(indicator);
      }
    });

    view.addEventListener('dragleave', (e) => {
      const zone = e.target.closest('.drop-target');
      if (zone && !zone.contains(e.relatedTarget)) clearDropTargets();
    });

    view.addEventListener('drop', (e) => {
      const zone = e.target.closest('[data-drop-status], [data-drop-date]');
      const id = state.dragId;
      const plan = id && findPlan(id);
      if (!zone || !plan) return;
      e.preventDefault();
      const beforeId = state.prefs.sort === 'manual' ? state.dropBeforeId : null;
      endDrag();

      if (zone.dataset.dropStatus) {
        const status = zone.dataset.dropStatus;
        // With an automatic sort, dropping into the same column changes nothing.
        if (status === plan.status && state.prefs.sort !== 'manual') return;
        setPlans(C.movePlan(state.plans, id, status, beforeId));
        if (status === 'done' && plan.status !== 'done') {
          celebrate({ x: e.clientX, y: e.clientY });
          toast(`Done: “${truncate(plan.title)}”`, { action: 'Undo', onAction: () => changeStatus(id, plan.status) });
        }
        return;
      }

      const date = zone.dataset.dropDate;
      if (plan.dueDate === date) return;
      const previous = { dueDate: plan.dueDate, dueTime: plan.dueTime };
      updatePlan(id, { dueDate: date });
      const message = date
        ? `Moved “${truncate(plan.title)}” to ${C.formatDate(C.parseISODate(date))}`
        : `Removed the deadline from “${truncate(plan.title)}”`;
      toast(message, { action: 'Undo', onAction: () => updatePlan(id, previous) });
    });

    view.addEventListener('dragend', endDrag);
  }

  /* --------------------------------------------------------------- editor */

  const editor = {
    dialog: $('#editor'),
    form: $('#editor-form'),
    id: null,
    tags: [],
    checklist: [],
    snapshot: '',
  };
  const field = (name) => editor.form.elements.namedItem(name);
  const isMeetingForm = () => field('kind').value === 'meeting';
  const KIND_SWITCH_LABELS = { plan: `${icon('check')}Plan`, meeting: `${icon('video')}Meeting` };
  const LINK_FIELDS = [
    ['meetingUrl', 'meeting-url-error'],
    ['jobUrl', 'job-url-error'],
  ];
  const oneLine = (value) => value.replace(/\s+/g, ' ').trim();

  function renderSegmented(containerId, name, values, labels, current) {
    $(`#${containerId}`).innerHTML = values
      .map(
        (v) => `<label class="seg seg-${v}">
          <input type="radio" name="${name}" value="${v}"${v === current ? ' checked' : ''} />
          <span>${labels[v]}</span>
        </label>`
      )
      .join('');
  }

  function openEditor(plan = null, defaults = {}) {
    editor.id = plan ? plan.id : null;
    const source = plan || {
      title: '',
      description: '',
      dueDate: '',
      dueTime: '',
      status: 'todo',
      priority: 'medium',
      tags: [],
      checklist: [],
      kind: 'plan',
      company: '',
      meetingUrl: '',
      jobUrl: '',
      ...defaults,
    };
    const meeting = source.kind === 'meeting';

    // A meeting titled after its company keeps following the company.
    const autoTitle = meeting && source.company && source.title === C.meetingTitle(source.company);
    field('title').value = autoTitle ? '' : source.title;
    renderSegmented('kind-options', 'kind', C.KINDS, KIND_SWITCH_LABELS, meeting ? 'meeting' : 'plan');
    field('company').value = source.company || '';
    field('meetingUrl').value = source.meetingUrl || '';
    field('jobUrl').value = source.jobUrl || '';
    for (const [name, errorId] of LINK_FIELDS) {
      $(`#${errorId}`).hidden = true;
      field(name).removeAttribute('aria-invalid');
    }
    setNameError(false);
    const companies = C.sortPlans(state.plans.filter(C.isMeeting), 'newest').map((p) => p.company);
    $('#company-suggestions').innerHTML = [...new Set(companies.filter(Boolean))]
      .slice(0, 50)
      .map((c) => `<option value="${esc(c)}"></option>`)
      .join('');
    field('description').value = source.description || '';
    field('dueDate').value = source.dueDate || '';
    field('dueTime').value = source.dueTime || '';
    renderSegmented('status-options', 'status', C.STATUSES, C.STATUS_LABELS, source.status);
    renderSegmented('priority-options', 'priority', C.PRIORITIES, C.PRIORITY_LABELS, source.priority);
    editor.tags = [...source.tags];
    editor.checklist = source.checklist.map((item) => ({ ...item }));
    $('#tag-input').value = '';
    $('#step-input').value = '';
    renderTagChips();
    renderSteps();
    $('#tag-suggestions').innerHTML = C.allTags(state.plans)
      .map((t) => `<option value="${esc(t.name)}"></option>`)
      .join('');

    $('#editor-delete').hidden = !plan;
    $('#editor-meta').textContent = plan ? metaLine(plan) : '';
    $('#title-error').hidden = true;
    editor.snapshot = editorSnapshot();
    editor.original = editorValues(); // to save only what the user changes
    applyKind();
    editor.dialog.showModal();
    if (!plan && meeting) {
      field('company').focus();
      return;
    }
    const title = field('title');
    title.focus();
    title.setSelectionRange(title.value.length, title.value.length);
  }

  // Shows the fields and wording for a plan or a meeting.
  function applyKind() {
    const meeting = isMeetingForm();
    for (const el of $$('.meeting-only', editor.form)) el.hidden = !meeting;
    for (const el of $$('.plan-only', editor.form)) el.hidden = meeting;
    const noun = meeting ? 'meeting' : 'plan';
    $('#editor-heading').textContent = `${editor.id ? 'Edit' : 'New'} ${noun}`;
    $('#editor-save').textContent = `Save ${noun}`;
    $('#title-label').textContent = meeting ? 'Title (optional)' : 'Title';
    $('#title-error').textContent = meeting ? 'Add the company name or a title.' : 'Give your plan a title.';
    $('#due-legend').textContent = meeting ? 'Date and time' : 'Deadline';
    field('dueDate').setAttribute('aria-label', meeting ? 'Meeting date' : 'Deadline date');
    field('dueTime').setAttribute('aria-label', meeting ? 'Meeting time' : 'Deadline time (optional)');
    $('#description-label').textContent = meeting ? 'Notes' : 'Description';
    field('description').placeholder = meeting
      ? "Who you're meeting, questions to ask, phone number…"
      : 'Notes, links, context…';
    $('#step-input').placeholder = meeting
      ? 'Add a prep step and press Enter'
      : 'Break it down: add a step and press Enter';
    const warn = Boolean(editor.id && editor.original?.kind === 'meeting' && !meeting);
    $('#kind-hint').hidden = !warn;
    // Read out with the selected type, but only while it's shown.
    for (const radio of $$('input[name="kind"]', editor.form)) {
      if (warn) radio.setAttribute('aria-describedby', 'kind-hint');
      else radio.removeAttribute('aria-describedby');
    }
    updateTitlePlaceholder();
    updateIcsButton();
  }

  function updateTitlePlaceholder() {
    const company = oneLine(field('company').value);
    if (!isMeetingForm()) field('title').placeholder = "What's the plan?";
    else field('title').placeholder = company ? C.meetingTitle(company) : 'e.g. Phone screen with Acme';
  }

  // "Add to my calendar" is offered for saved meetings that have a date.
  function updateIcsButton() {
    $('#editor-ics-row').hidden = !(isMeetingForm() && editor.id);
    const dated = Boolean(field('dueDate').value);
    $('#editor-ics').disabled = !dated;
    $('#ics-hint').textContent = dated
      ? 'Downloads a file your calendar app can open, with a reminder 15 minutes before.'
      : 'Add a date first.';
  }

  function metaLine(plan) {
    const parts = [`Created ${timeAgo(plan.createdAt)}`];
    if (plan.startedAt && plan.status !== 'todo') parts.push(`started ${timeAgo(plan.startedAt)}`);
    if (plan.completedAt) {
      parts.push(`finished ${timeAgo(plan.completedAt)}`);
      const from = plan.startedAt || plan.createdAt;
      const took = new Date(plan.completedAt) - new Date(from);
      if (took > 0) parts.push(`took ${duration(took)}`);
    }
    return parts.join(' · ');
  }

  // The plan's fields as the editor shows them, in the same shape at open and at save.
  function editorValues() {
    let dueDate = field('dueDate').value;
    const dueTime = field('dueTime').value;
    if (dueTime && !dueDate) dueDate = C.toISODate(new Date());
    const meeting = isMeetingForm();
    const company = meeting ? oneLine(field('company').value) : '';
    // A pasted invitation is fine: the link is picked out of it.
    const link = (name) => (meeting ? C.cleanUrl(C.extractUrl(field(name).value)) : '');
    return {
      kind: meeting ? 'meeting' : 'plan',
      company,
      meetingUrl: link('meetingUrl'),
      jobUrl: link('jobUrl'),
      title: field('title').value.trim() || (meeting ? C.meetingTitle(company) : ''),
      description: field('description').value.trim(),
      dueDate,
      dueTime: dueDate ? dueTime : '',
      status: field('status').value,
      priority: field('priority').value,
      tags: [...editor.tags],
      checklist: editor.checklist.filter((item) => item.text.trim()).map((item) => ({ ...item })),
    };
  }

  function editorSnapshot() {
    return JSON.stringify([
      field('kind').value,
      field('company').value,
      field('meetingUrl').value,
      field('jobUrl').value,
      field('title').value,
      field('description').value,
      field('dueDate').value,
      field('dueTime').value,
      field('status').value,
      field('priority').value,
      editor.tags,
      editor.checklist,
      $('#tag-input').value,
      $('#step-input').value,
    ]);
  }

  function requestCloseEditor() {
    const noun = isMeetingForm() ? 'meeting' : 'plan';
    if (editorSnapshot() !== editor.snapshot && !window.confirm(`Discard your changes to this ${noun}?`)) return false;
    editor.dialog.close();
    return true;
  }

  function renderTagChips() {
    $('#tag-chips').innerHTML = editor.tags
      .map(
        (t, i) => `<span class="chip tag">#${esc(t)}
          <button type="button" class="chip-remove" data-remove-tag="${i}" aria-label="Remove tag ${esc(t)}">${icon('x')}</button>
        </span>`
      )
      .join('');
  }

  function addTag(value) {
    const tag = C.normalizeTag(value);
    if (tag && !editor.tags.includes(tag) && editor.tags.length < 20) editor.tags.push(tag);
    renderTagChips();
  }

  function renderSteps() {
    $('#steps-list').innerHTML = editor.checklist
      .map(
        (item, i) => `
        <li class="step${item.done ? ' done' : ''}" data-index="${i}">
          <input type="checkbox" class="step-check"${item.done ? ' checked' : ''} aria-label="Step ${i + 1} done" />
          <input type="text" class="step-text" value="${esc(item.text)}" maxlength="300" aria-label="Step ${i + 1}" />
          <button type="button" class="icon-btn small step-remove" aria-label="Remove step ${i + 1}">${icon('x')}</button>
        </li>`
      )
      .join('');
    updateStepsSummary();
  }

  function updateStepsSummary() {
    const total = editor.checklist.length;
    const done = editor.checklist.filter((item) => item.done).length;
    $('#steps-count').textContent = total ? `${done} of ${total} done` : '';
    const bar = $('#steps-progress');
    bar.hidden = !total;
    bar.firstElementChild.style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
    $('#finish-hint').hidden = !(total && done === total && field('status').value !== 'done');
  }

  // Checks the form before saving. A link that isn't a web address is never
  // dropped silently: the editor stays open and says what's wrong.
  function validateEditor() {
    const meeting = isMeetingForm();
    const problems = [];
    const named = Boolean(field('title').value.trim() || (meeting && field('company').value.trim()));
    $('#title-error').hidden = named;
    // For a meeting the cursor goes to Company, so the message is read out there.
    setNameError(meeting && !named);
    if (!named) problems.push(field(meeting ? 'company' : 'title'));
    for (const [name, errorId] of LINK_FIELDS) {
      const value = field(name).value.trim();
      const bad = meeting && Boolean(value) && !C.cleanUrl(C.extractUrl(value));
      $(`#${errorId}`).hidden = !bad;
      field(name).setAttribute('aria-invalid', String(bad));
      if (bad) problems.push(field(name));
    }
    if (problems.length) problems[0].focus();
    return !problems.length;
  }

  function setNameError(on) {
    const company = field('company');
    if (on) {
      company.setAttribute('aria-invalid', 'true');
      company.setAttribute('aria-describedby', 'title-error');
    } else {
      company.removeAttribute('aria-invalid');
      company.removeAttribute('aria-describedby');
    }
  }

  function saveEditor() {
    if (!validateEditor()) return;
    if ($('#tag-input').value.trim()) addTag($('#tag-input').value);
    if ($('#step-input').value.trim()) {
      editor.checklist.push({ id: C.uid(), text: $('#step-input').value.trim(), done: false });
    }

    const values = editorValues();
    const point = centerOf(editor.form.querySelector('[type="submit"]'));
    editor.dialog.close();

    if (!editor.id) {
      const plan = addPlan(values);
      if (values.status === 'done') celebrate(point);
      if (C.isMeeting(plan) && plan.dueDate) {
        toast(`Added “${truncate(plan.title)}” for ${C.dueInfo(plan).full}`, {
          action: 'Add to my calendar',
          onAction: () => downloadICS(findPlan(plan.id) || plan),
        });
      } else {
        toast(`Added “${truncate(plan.title)}”`);
      }
      return;
    }

    const before = findPlan(editor.id);
    if (!before) {
      const edited = JSON.stringify(values) !== JSON.stringify(editor.original);
      if (!edited) {
        toast('This plan was deleted on another device.');
        return;
      }
      // Don't throw away what was typed: save it again as a plan.
      const plan = addPlan(values);
      toast(`“${truncate(plan.title)}” was deleted on another device. Your version was saved again.`, {
        action: 'Undo',
        onAction: () => setPlans(state.plans.filter((p) => p.id !== plan.id)),
      });
      return;
    }
    // Only fields changed in the editor are saved, onto the plan as it is now,
    // so an update from another device while the editor was open isn't undone.
    const changes = {};
    for (const key of Object.keys(values)) {
      if (key !== 'status' && JSON.stringify(values[key]) !== JSON.stringify(editor.original[key])) {
        changes[key] = values[key];
      }
    }
    const newStatus = values.status !== editor.original.status && values.status !== before.status ? values.status : '';
    if (!Object.keys(changes).length && !newStatus) return;

    const now = new Date();
    let plans = state.plans;
    if (Object.keys(changes).length) {
      plans = plans.map((p) =>
        p.id === editor.id ? C.normalizePlan({ ...p, ...changes, updatedAt: C.nextStamp(p.updatedAt, now) }, now) : p
      );
    }
    if (newStatus) plans = placeAtTop(plans, editor.id, newStatus);
    setPlans(plans);
    if (newStatus === 'done') celebrate(point);
  }

  function setupEditor() {
    const { dialog, form } = editor;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      saveEditor();
    });

    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveEditor();
      }
    });

    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      requestCloseEditor();
    });

    for (const btn of $$('[data-close]', dialog)) btn.addEventListener('click', requestCloseEditor);

    field('title').addEventListener('input', () => {
      $('#title-error').hidden = true;
      setNameError(false);
    });

    $('#editor-delete').addEventListener('click', () => {
      const id = editor.id;
      editor.dialog.close();
      deletePlan(id);
    });

    $('.quick-dates', form).addEventListener('click', (e) => {
      const btn = e.target.closest('[data-due]');
      if (!btn) return;
      const value = btn.dataset.due;
      const now = new Date();
      if (value === '') {
        field('dueDate').value = '';
        field('dueTime').value = '';
      } else if (value === 'next-week') {
        field('dueDate').value = C.toISODate(C.addDays(now, (1 - now.getDay() + 7) % 7 || 7));
      } else {
        field('dueDate').value = C.toISODate(C.addDays(now, Number(value)));
      }
      updateIcsButton();
    });

    form.addEventListener('change', (e) => {
      if (e.target.name === 'status') updateStepsSummary();
      if (e.target.name === 'kind') {
        // A plan needs a real title: keep the automatic one when leaving
        // meetings, and let it follow the company again when coming back.
        const title = field('title');
        const auto = C.meetingTitle(oneLine(field('company').value));
        if (!isMeetingForm() && !title.value.trim() && auto) title.value = auto;
        else if (isMeetingForm() && auto && title.value.trim() === auto) title.value = '';
        applyKind();
      }
    });

    // Meetings
    field('company').addEventListener('input', () => {
      updateTitlePlaceholder();
      $('#title-error').hidden = true;
      setNameError(false);
    });
    for (const [name, errorId] of LINK_FIELDS) {
      const input = field(name);
      input.addEventListener('input', () => {
        $(`#${errorId}`).hidden = true;
        input.setAttribute('aria-invalid', 'false');
      });
      // Tidy a pasted link when leaving the field, e.g. "zoom.us/j/1" → "https://zoom.us/j/1".
      input.addEventListener('change', () => {
        const cleaned = C.cleanUrl(C.extractUrl(input.value));
        if (cleaned) input.value = cleaned;
      });
    }
    for (const type of ['input', 'change']) field('dueDate').addEventListener(type, updateIcsButton);
    $('#editor-ics').addEventListener('click', () => downloadICS({ ...editorValues(), id: editor.id }));
    let zone = '';
    try {
      const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'long' }).formatToParts(new Date());
      zone = parts.find((part) => part.type === 'timeZoneName')?.value || '';
    } catch {
      /* no time zone name available */
    }
    $('#zone-hint').textContent = zone ? `Times are in your time zone (${zone}).` : 'Times are in your time zone.';

    // Tags
    const tagInput = $('#tag-input');
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        if (tagInput.value.trim()) addTag(tagInput.value);
        tagInput.value = '';
      } else if (e.key === 'Backspace' && !tagInput.value && editor.tags.length) {
        editor.tags.pop();
        renderTagChips();
      }
    });
    tagInput.addEventListener('change', () => {
      // Picking from the datalist fires "change" without a keypress.
      if (C.allTags(state.plans).some((t) => t.name === tagInput.value)) {
        addTag(tagInput.value);
        tagInput.value = '';
      }
    });
    $('#tag-chips').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-tag]');
      if (!btn) return;
      editor.tags.splice(Number(btn.dataset.removeTag), 1);
      renderTagChips();
      tagInput.focus();
    });

    // Steps
    const stepInput = $('#step-input');
    stepInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      const value = stepInput.value.trim();
      if (!value) return;
      editor.checklist.push({ id: C.uid(), text: value, done: false });
      stepInput.value = '';
      renderSteps();
    });

    const list = $('#steps-list');
    const indexOf = (el) => Number(el.closest('.step').dataset.index);
    list.addEventListener('change', (e) => {
      if (!e.target.classList.contains('step-check')) return;
      const item = editor.checklist[indexOf(e.target)];
      item.done = e.target.checked;
      e.target.closest('.step').classList.toggle('done', item.done);
      updateStepsSummary();
    });
    list.addEventListener('input', (e) => {
      if (e.target.classList.contains('step-text')) editor.checklist[indexOf(e.target)].text = e.target.value;
    });
    list.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('step-text') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        stepInput.focus();
      }
    });
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.step-remove');
      if (!btn) return;
      editor.checklist.splice(indexOf(btn), 1);
      renderSteps();
      stepInput.focus();
    });

    $('#finish-hint').addEventListener('click', () => {
      const done = editor.form.querySelector('input[name="status"][value="done"]');
      done.checked = true;
      updateStepsSummary();
    });
  }

  /* ------------------------------------------------------------ quick add */

  function setupQuickAdd() {
    const form = $('#quick-add');
    const input = $('#qa-input');

    const openDetails = () => {
      const parsed = C.parseQuickAdd(input.value);
      openEditor(null, {
        title: parsed.title,
        dueDate: parsed.dueDate,
        dueTime: parsed.dueTime,
        priority: parsed.priority || 'medium',
        tags: parsed.tags,
      });
      input.value = '';
      renderQuickPreview();
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!input.value.trim()) {
        input.focus();
        return;
      }
      const parsed = C.parseQuickAdd(input.value);
      if (!parsed.title) {
        form.classList.remove('shake');
        void form.offsetWidth; // restart the animation
        form.classList.add('shake');
        toast('Add a few words that describe the plan.');
        return;
      }
      const plan = addPlan({ ...parsed, priority: parsed.priority || 'medium' });
      input.value = '';
      renderQuickPreview();
      const due = C.dueInfo(plan);
      const hidden = !C.matchesFilters(plan, state.filters) ? ' (hidden by filters)' : '';
      toast(`Added “${truncate(plan.title)}”${due.state !== 'none' ? `, ${due.label.toLowerCase()}` : ''}${hidden}`, {
        action: 'Edit',
        onAction: () => findPlan(plan.id) && openEditor(findPlan(plan.id)),
      });
    });

    input.addEventListener('input', renderQuickPreview);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        openDetails();
      } else if (e.key === 'Escape') {
        input.value = '';
        renderQuickPreview();
        input.blur();
      }
    });
    $('#qa-details').addEventListener('click', openDetails);
  }

  function renderQuickPreview() {
    const value = $('#qa-input').value;
    const box = $('#qa-preview');
    $('#quick-add').classList.toggle('has-text', Boolean(value.trim()));
    if (!value.trim()) {
      box.innerHTML = '';
      return;
    }
    const parsed = C.parseQuickAdd(value);
    const chips = [];
    if (parsed.dueDate) {
      const due = C.dueInfo({ ...parsed, status: 'todo' });
      chips.push(`<span class="chip due due-${due.state}">${icon('clock')}${esc(due.full)}</span>`);
    }
    if (parsed.priority) chips.push(priorityChip(parsed.priority));
    for (const t of parsed.tags) chips.push(`<span class="chip tag">#${esc(t)}</span>`);
    box.innerHTML = chips.length
      ? `<span class="qa-title">${parsed.title ? `“${esc(truncate(parsed.title, 60))}”` : '<em>Needs a title</em>'}</span>${chips.join('')}`
      : '';
  }

  /* -------------------------------------------------------------- toasts */

  let toastTimer = null;
  let toastDuration = 0;

  function hideToast() {
    const el = $('#toast');
    el.classList.remove('show');
    clearTimeout(toastTimer);
    setTimeout(() => {
      if (el.classList.contains('show')) return;
      el.hidden = true;
      try {
        if (el.matches(':popover-open')) el.hidePopover();
      } catch {
        /* no Popover API */
      }
    }, 250);
  }

  // Shown as a popover so it sits above any open dialog (e.g. Manage users).
  function raiseToast(el) {
    if (typeof el.showPopover !== 'function') return;
    try {
      if (el.matches(':popover-open')) el.hidePopover(); // re-show to come out on top
      el.showPopover();
    } catch {
      /* fall back to the normal fixed position */
    }
  }

  function toast(message, { action = '', onAction = null } = {}) {
    const el = $('#toast');
    const btn = $('#toast-action');
    $('#toast-text').textContent = message;
    btn.hidden = !action;
    btn.textContent = action;
    btn.onclick = action
      ? () => {
          hideToast();
          onAction();
        }
      : null;
    el.hidden = false;
    raiseToast(el);
    requestAnimationFrame(() => el.classList.add('show'));
    toastDuration = action ? 7000 : 3500;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, toastDuration);
  }

  /* ------------------------------------------------------------ confetti */

  function celebrate(point) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = $('#confetti');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const origin = point || { x: window.innerWidth / 2, y: window.innerHeight / 3 };
    const colors = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899'];
    const pieces = Array.from({ length: 90 }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 3 + Math.random() * 7;
      return {
        x: origin.x,
        y: origin.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 5,
        w: 5 + Math.random() * 5,
        h: 3 + Math.random() * 4,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 1,
      };
    });

    let last = performance.now();
    const frame = (t) => {
      const dt = Math.min(48, t - last) / 16.7;
      last = t;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      let alive = false;
      for (const p of pieces) {
        p.vy += 0.32 * dt;
        p.vx *= 0.985;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        p.life -= 0.011 * dt;
        if (p.life <= 0 || p.y > window.innerHeight + 20) continue;
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.min(1, p.life * 2);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (alive) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    };
    requestAnimationFrame(frame);
  }

  /* --------------------------------------------------------------- theme */

  function applyTheme() {
    const root = document.documentElement;
    if (state.prefs.theme) root.dataset.theme = state.prefs.theme;
    else delete root.dataset.theme;
  }

  function toggleTheme() {
    const dark = state.prefs.theme
      ? state.prefs.theme === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    state.prefs.theme = dark ? 'light' : 'dark';
    savePrefs();
    // Switch every color at once instead of letting each one fade.
    const root = document.documentElement;
    root.classList.add('theme-switching');
    applyTheme();
    void window.getComputedStyle(root).color; // apply the new colors before transitions return
    requestAnimationFrame(() => root.classList.remove('theme-switching'));
  }

  /* ------------------------------------------------------- menu & import */

  function downloadFile(content, type, name) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportPlans() {
    downloadFile(
      JSON.stringify(C.exportData(state.plans), null, 2),
      'application/json',
      `dayplan-backup-${C.toISODate(new Date())}.json`
    );
    toast(`Exported ${state.plans.length} ${state.plans.length === 1 ? 'plan' : 'plans'}`);
  }

  // A calendar file (.ics) the phone or computer calendar can open, with a
  // reminder 15 minutes before the meeting.
  function downloadICS(plan) {
    const text = C.meetingICS(plan);
    if (!text) {
      toast('Add a date to the meeting first.');
      return;
    }
    downloadFile(text, 'text/calendar;charset=utf-8', C.icsFileName(plan));
    toast('Calendar file downloaded. Open it to add the meeting to your calendar.');
  }

  function openNewMeeting() {
    openEditor(null, { kind: 'meeting', dueDate: state.prefs.view === 'calendar' ? state.selectedDay : '' });
  }

  async function importPlans(file) {
    try {
      // An older backup has no meeting details: keep the ones already here.
      const incoming = C.importData(await file.text(), new Date(), state.plans);
      const byId = new Map(state.plans.map((p) => [p.id, p]));
      const sameContent = (a, b) => JSON.stringify({ ...a, updatedAt: '' }) === JSON.stringify({ ...b, updatedAt: '' });
      const touched = []; // what the import changed, to undo exactly that
      for (const plan of incoming) {
        const previous = byId.get(plan.id) || null;
        if (previous && sameContent(previous, plan)) continue;
        touched.push({ id: plan.id, previous });
        byId.set(plan.id, restored(plan, previous || plan));
      }
      setPlans([...byId.values()]);
      const added = touched.filter((t) => !t.previous).length;
      const updated = touched.length - added;
      const summary = touched.length
        ? `Imported ${added} new ${added === 1 ? 'plan' : 'plans'}${updated ? `, updated ${updated}` : ''}`
        : 'Nothing to import: these plans are already here.';
      toast(summary, {
        action: touched.length ? 'Undo' : '',
        onAction: () => {
          // Applied to the plans as they are now, so changes that arrived from
          // other devices in the meantime are kept.
          const current = new Map(state.plans.map((p) => [p.id, p]));
          for (const { id, previous } of touched) {
            if (previous) current.set(id, restored(previous, current.get(id) || previous));
            else current.delete(id);
          }
          setPlans([...current.values()]);
        },
      });
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
  }

  function addSamples() {
    setPlans([...C.samplePlans(), ...state.plans]);
    toast('Added sample plans. Edit or delete them any time.');
  }

  function clearCompleted() {
    const done = state.plans.filter((p) => p.status === 'done');
    if (!done.length) {
      toast('There are no completed plans to clear.');
      return;
    }
    setPlans(state.plans.filter((p) => p.status !== 'done'));
    toast(`Cleared ${done.length} completed ${done.length === 1 ? 'plan' : 'plans'}`, {
      action: 'Undo',
      onAction: () => setPlans([...state.plans, ...done.filter((d) => !findPlan(d.id)).map(undeleted)]),
    });
  }

  function setupMenu() {
    const menu = $('#menu');
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-menu]');
      if (!item) return;
      menu.open = false;
      switch (item.dataset.menu) {
        case 'export':
          exportPlans();
          break;
        case 'import':
          $('#import-file').click();
          break;
        case 'samples':
          addSamples();
          break;
        case 'clear-done':
          clearCompleted();
          break;
        case 'new-meeting':
          openNewMeeting();
          break;
        case 'shortcuts':
          $('#shortcuts').showModal();
          break;
        default:
      }
    });
    document.addEventListener('click', (e) => {
      for (const open of $$('details.menu[open]')) if (!open.contains(e.target)) open.open = false;
    });
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menu.open) {
        menu.open = false;
        $('summary', menu).focus();
      }
    });
    $('#import-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) importPlans(file);
    });
    for (const btn of $$('#shortcuts [data-close]')) btn.addEventListener('click', () => $('#shortcuts').close());
  }

  /* ------------------------------------------------------- accounts & sync */

  // When the page is served by dayplan_wsgi.py (e.g. on PythonAnywhere),
  // people can sign in and their plans are kept in their account, so every
  // browser they sign in with shows the same plans. Opened as a plain file,
  // none of this appears and plans stay in this browser only.

  const SYNC_KEY = 'dayplan.sync.v1';
  const LOGOUT_KEY = 'dayplan.logout-pending';
  const SYNC_TEXT = {
    saved: 'All changes saved to your account',
    saving: 'Saving…',
    offline: "You're offline. Changes will be saved when you reconnect.",
    error: "Couldn't save your changes. Trying again…",
  };

  const sync = {
    available: false, // the server supports accounts
    connected: false, // /api/me has answered since the page loaded
    // What we know about the server: unknown (still asking), none (no accounts
    // here, e.g. index.html opened as a file), ok, or unreachable.
    server: location.protocol === 'file:' ? 'none' : 'unknown',
    signupOpen: false,
    first: false, // no account exists yet: the next one becomes the admin
    user: '', // email of the signed-in account
    admin: false,
    pendingUsers: 0, // sign-up requests waiting for the admin
    notifiedPending: 0,
    epoch: '', // id of the server database this browser synced with
    cursor: 0, // last server revision this browser has seen
    pending: new Set(), // plan ids changed here and not yet sent
    inflight: new Set(), // ids in the request running now; kept until the server confirms
    deletedAt: new Map(), // when each unsent deletion happened
    running: null,
    again: false,
    timer: null,
    retryDelay: 0,
    status: 'saved',
  };

  function loadSyncState() {
    try {
      const saved = JSON.parse(readStorage(SYNC_KEY) || '{}');
      if (typeof saved.user !== 'string' || !saved.user) return;
      sync.user = saved.user;
      sync.admin = saved.admin === true;
      sync.epoch = typeof saved.epoch === 'string' ? saved.epoch : '';
      sync.cursor = Number.isInteger(saved.cursor) && saved.cursor >= 0 ? saved.cursor : 0;
      const pending = Array.isArray(saved.pending) ? saved.pending : [];
      sync.pending = new Set(pending.filter((id) => typeof id === 'string'));
      const deleted = saved.deletedAt && typeof saved.deletedAt === 'object' ? saved.deletedAt : {};
      sync.deletedAt = new Map(Object.entries(deleted).filter(([, at]) => typeof at === 'string'));
    } catch {
      /* start without an account */
    }
  }

  // In-flight ids are stored as pending too, so an edit that was being sent
  // when the tab closed is sent again next time.
  function saveSyncState() {
    if (!sync.user) {
      removeStorage(SYNC_KEY);
      return;
    }
    const ids = [...new Set([...sync.pending, ...sync.inflight])];
    const deletedAt = {};
    for (const id of ids) if (sync.deletedAt.has(id)) deletedAt[id] = sync.deletedAt.get(id);
    writeStorage(
      SYNC_KEY,
      JSON.stringify({ user: sync.user, admin: sync.admin, epoch: sync.epoch, cursor: sync.cursor, pending: ids, deletedAt })
    );
  }

  function clearSyncState() {
    clearTimeout(sync.timer);
    sync.user = '';
    sync.admin = false;
    sync.pendingUsers = 0;
    sync.notifiedPending = 0;
    sync.epoch = '';
    sync.cursor = 0;
    sync.pending.clear();
    sync.inflight.clear();
    sync.deletedAt.clear();
    sync.retryDelay = 0;
    sync.status = 'saved';
    saveSyncState();
  }

  // Remembers which plans changed (or were deleted, and when) so they get sent.
  function trackChanges(before, after) {
    const old = new Map(before.map((p) => [p.id, p]));
    const present = new Set(after.map((p) => p.id));
    for (const id of C.changedPlanIds(before, after)) {
      sync.pending.add(id);
      // A deletion is stamped later than the version it removes, like an edit,
      // so it sticks even if this device's clock runs behind.
      if (present.has(id)) sync.deletedAt.delete(id);
      else sync.deletedAt.set(id, C.nextStamp(old.has(id) ? old.get(id).updatedAt : ''));
    }
    saveSyncState();
    scheduleSync();
  }

  // Deletions that hadn't reached the account when this browser was signed
  // out by the server (expired sign-in, password reset), plus any made since.
  // They're sent when the same account signs in again, so those plans don't
  // come back.
  const UNSENT_DELETES_KEY = 'dayplan.unsent-deletes.v1';

  function loadUnsentDeletes() {
    try {
      const saved = JSON.parse(readStorage(UNSENT_DELETES_KEY) || 'null');
      return saved && typeof saved.user === 'string' && saved.deleted && typeof saved.deleted === 'object' ? saved : null;
    } catch {
      return null;
    }
  }

  function keepUnsentDeletes(user, deleted) {
    if (Object.keys(deleted).length) writeStorage(UNSENT_DELETES_KEY, JSON.stringify({ user, deleted }));
    else removeStorage(UNSENT_DELETES_KEY);
  }

  // Called for every change while signed out.
  function trackDeletesWhileSignedOut(before, after) {
    const saved = loadUnsentDeletes();
    if (!saved) return;
    const present = new Set(after.map((p) => p.id));
    for (const plan of before) {
      if (!present.has(plan.id)) saved.deleted[plan.id] = C.nextStamp(plan.updatedAt);
    }
    for (const id of Object.keys(saved.deleted)) if (present.has(id)) delete saved.deleted[id]; // undone
    keepUnsentDeletes(saved.user, saved.deleted);
  }

  // Another tab signed in, signed out or synced.
  function adoptSyncStateFromOtherTab() {
    const mine = new Set([...sync.pending, ...sync.inflight]);
    const myDeletes = new Map(sync.deletedAt);
    const wasUser = sync.user;
    sync.user = '';
    sync.admin = false;
    loadSyncState();
    if (sync.user && sync.user === wasUser) {
      // Keep this tab's own unsent edits too (older copies are refused by the server).
      for (const id of mine) sync.pending.add(id);
      for (const [id, at] of myDeletes) if (!sync.deletedAt.has(id)) sync.deletedAt.set(id, at);
    } else {
      sync.pendingUsers = 0;
      sync.notifiedPending = 0;
    }
    updateAccountUI();
    if (state.dragId) state.renderAfterDrag = true;
    else render();
    if (sync.user) syncNow(); // also refreshes the admin's waiting count
  }

  const REQUEST_TIMEOUT_MS = 30000;

  async function api(path, body) {
    // A request that hangs (weak mobile signal) becomes a retryable error.
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    let response;
    try {
      response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* not JSON, e.g. an error page from a proxy */
    }
    if (!response.ok) {
      let message = data && data.error;
      if (!message) {
        message =
          response.status >= 500
            ? 'The server is having a problem. Please try again in a minute.'
            : `Something went wrong (error ${response.status}). Please reload the page.`;
      }
      const err = new Error(message);
      err.status = response.status;
      throw err;
    }
    return data;
  }

  function scheduleSync(delay = 700) {
    if (!sync.user) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(syncNow, delay);
  }

  // Sends local changes and fetches changes made in other browsers.
  // Only one request runs at a time; calls made meanwhile run right after.
  function syncNow() {
    if (!sync.user || !sync.available) return Promise.resolve();
    if (sync.running) {
      sync.again = true;
      return sync.running;
    }
    clearTimeout(sync.timer);
    sync.running = runSync().finally(() => {
      sync.running = null;
      if (sync.again) {
        sync.again = false;
        scheduleSync(0);
      }
    });
    return sync.running;
  }

  async function runSync() {
    const user = sync.user;
    // After reading plans saved by an older version, download the whole
    // account once: the server kept the meeting details those copies lack.
    const pullTo = olderDataLoads;
    const fullPull = pullTo > olderDataPulled;
    // Edits to plans read from such a copy wait for that download: the
    // account may hold meeting details the copy lacks, which sending it as is
    // would erase.
    const held = fullPull ? [...sync.pending].filter((id) => olderIds.has(id) && findPlan(id)) : [];
    const ids = [...sync.pending].filter((id) => !held.includes(id));
    for (const id of ids) {
      sync.pending.delete(id);
      sync.inflight.add(id);
    }
    const changes = ids.map((id) => {
      const plan = findPlan(id);
      if (plan) return { id, data: plan };
      return { id, data: null, deletedAt: sync.deletedAt.get(id) || new Date().toISOString() };
    });
    if (ids.length) setSyncStatus('saving');
    try {
      const result = await api('api/sync', {
        epoch: sync.epoch || undefined,
        cursor: sync.cursor,
        full: fullPull || undefined,
        changes,
      });
      if (sync.user !== user) return; // signed out while this was running
      sync.inflight.clear();
      if (result.reset) {
        // A different database (e.g. restored from a copy): pull everything and
        // offer every local plan again. The server keeps whichever copy is newer.
        sync.epoch = result.epoch || '';
        sync.cursor = 0;
        for (const id of ids) sync.pending.add(id);
        for (const plan of state.plans) sync.pending.add(plan.id);
        saveSyncState();
        sync.again = true;
        return;
      }
      sync.epoch = result.epoch || sync.epoch;
      sync.cursor = result.cursor;
      for (const id of ids) if (!sync.pending.has(id)) sync.deletedAt.delete(id);
      // Only admins get a waiting count, so its presence is the source of truth.
      const isAdmin = typeof result.pending === 'number';
      if (isAdmin !== sync.admin) {
        sync.admin = isAdmin;
        if (!isAdmin) sync.pendingUsers = 0;
        updateAccountUI();
      }
      if (isAdmin) setPendingUsers(result.pending);
      // The server also returns its own copy of anything it refused as out of date.
      const next = C.applyRemoteChanges(state.plans, result.changes || [], sync.pending);
      if (next !== state.plans) {
        state.plans = next;
        savePlans();
        if (state.dragId) state.renderAfterDrag = true; // don't pull the card out from under the pointer
        else render();
      }
      if (fullPull) {
        // Put the account's meeting details back onto the held edits.
        const server = new Map((result.changes || []).map((c) => [c.id, c.data]));
        let repaired = false;
        state.plans = state.plans.map((p) => {
          const copy = server.get(p.id);
          if (!held.includes(p.id) || C.isMeeting(p) || !C.isMeeting(copy)) return p;
          repaired = true;
          const { company, meetingUrl, jobUrl } = copy;
          return C.normalizePlan({ ...p, kind: 'meeting', company, meetingUrl, jobUrl });
        });
        if (repaired) render();
        if (pullTo === olderDataLoads) olderIds.clear(); // unless another old copy was read meanwhile
        if (held.length) sync.again = true;
        olderDataPulled = pullTo;
        savePlans(); // stored in the current format now, so this isn't repeated
      }
      sync.retryDelay = 0;
      saveSyncState();
      setSyncStatus(sync.pending.size ? 'saving' : 'saved');
    } catch (err) {
      if (sync.user !== user) return;
      for (const id of sync.inflight) sync.pending.add(id);
      sync.inflight.clear();
      saveSyncState();
      if (err.status === 401) {
        signedOutElsewhere();
        return;
      }
      setSyncStatus(err.status ? 'error' : 'offline');
      sync.retryDelay = Math.min(sync.retryDelay ? sync.retryDelay * 2 : 5000, 5 * 60 * 1000);
      scheduleSync(sync.retryDelay);
    }
  }

  // Signs this browser in to `email`. Plans already here are offered to the
  // account; the server keeps whichever copy of each plan is newer.
  function startSession(email, admin = false) {
    sync.user = email;
    sync.admin = Boolean(admin);
    sync.epoch = '';
    sync.cursor = 0;
    sync.pending = new Set(state.plans.map((p) => p.id));
    sync.inflight.clear();
    sync.deletedAt.clear();
    const unsent = loadUnsentDeletes();
    if (unsent && unsent.user === email) {
      for (const [id, at] of Object.entries(unsent.deleted)) {
        if (findPlan(id)) continue;
        sync.pending.add(id);
        sync.deletedAt.set(id, at);
      }
    }
    removeStorage(UNSENT_DELETES_KEY);
    sync.retryDelay = 0;
    removeStorage(LOGOUT_KEY); // this sign-in replaces any unfinished sign-out
    saveSyncState();
    updateAccountUI();
    render();
    return syncNow();
  }

  // The server no longer knows this browser's sign-in (expired, or the
  // password was changed). Plans stay here; signing in again merges them.
  function signedOutElsewhere() {
    const email = sync.user;
    const deleted = {};
    for (const id of new Set([...sync.pending, ...sync.inflight])) {
      if (!findPlan(id) && sync.deletedAt.has(id)) deleted[id] = sync.deletedAt.get(id);
    }
    keepUnsentDeletes(email, deleted);
    clearSyncState();
    auth.mode = 'signin';
    authField('email').value = email;
    authField('password').value = '';
    updateAccountUI();
    render();
    toast('You were signed out. Sign in again to keep your plans in sync.', {
      action: 'Sign in',
      onAction: () => openAuth('signin', email),
    });
  }

  async function signOut() {
    // Send everything first, including edits made while a sync was running.
    for (let i = 0; i < 3 && sync.user && (sync.pending.size || sync.running); i += 1) await syncNow();
    if (!sync.user) return; // the server had already signed this browser out
    if (
      sync.pending.size &&
      !window.confirm(
        "Some changes haven't reached your account yet, maybe because you're offline. Sign out anyway and lose them on this browser?"
      )
    ) {
      return;
    }
    try {
      await api('api/logout', {});
      removeStorage(LOGOUT_KEY);
    } catch {
      // Offline: finish signing out on the server next time the page loads.
      writeStorage(LOGOUT_KEY, '1');
    }
    clearSyncState();
    removeStorage(UNSENT_DELETES_KEY);
    auth.mode = 'signin';
    auth.form.reset();
    // Plans are safe in the account; don't leave them on a shared computer.
    // (Set directly, not through setPlans: clearing this browser is not a deletion.)
    state.plans = [];
    savePlans();
    updateAccountUI();
    render();
    toast('Signed out. Your plans are safe in your account.');
  }

  function setSyncStatus(status) {
    sync.status = status;
    $('#sync-dot').dataset.status = status;
    $('#sync-text').textContent = SYNC_TEXT[status];
    updateAccountLabel();
  }

  function updateAccountLabel() {
    const waiting = sync.admin && sync.pendingUsers ? ` ${sync.pendingUsers} waiting for approval.` : '';
    const summary = $('#account summary');
    summary.setAttribute('aria-label', `Account: ${sync.user}. ${SYNC_TEXT[sync.status]}${waiting}`);
    summary.title = `${sync.user}\n${SYNC_TEXT[sync.status]}${waiting ? `\n${waiting.trim()}` : ''}`;
  }

  function updateAccountUI() {
    const signedIn = Boolean(sync.user);
    $('#account').hidden = !signedIn;
    if (signedIn) {
      $('#account-email').textContent = sync.user;
      $('#account-initial').textContent = sync.user.charAt(0).toUpperCase();
    } else {
      $('#account').open = false;
    }
    setSyncStatus(sync.status);
    updateAdminBadge();
    updateGate();
  }

  // On a site with accounts the planner is only for signed-in people: anyone
  // else sees a sign-in page. Opened as a plain file, there's no gate.
  let gateStatusHTML = '';
  let gateFormShown = false;

  function updateGate() {
    const show = !sync.user && sync.server !== 'none';
    $('#gate').hidden = !show;
    document.body.classList.toggle('gated', show);
    $('.shell').inert = show;
    const ready = show && sync.server === 'ok';
    $('#gate-status').hidden = ready;
    $('#auth').hidden = !ready;
    if (!show) {
      gateFormShown = false;
      return;
    }
    if (ready) {
      renderAuthMode();
      if (!gateFormShown) {
        gateFormShown = true;
        // Ready to type on computers; phones don't pop up the keyboard unasked.
        const fine = window.matchMedia('(pointer: fine)').matches;
        if (fine && !$('#gate').contains(document.activeElement)) {
          (authField('email').value ? authField('password') : authField('email')).focus();
        }
      }
      return;
    }
    gateFormShown = false;
    let text = 'Connecting…';
    let actions = '';
    if (sync.server === 'unreachable') {
      text = "Can't reach the server right now. Check your connection.";
      actions = '<button type="button" class="btn primary" data-gate="retry">Try again</button>';
    }
    if (`${text}|${actions}` === gateStatusHTML) return; // don't rebuild (and lose focus) for nothing
    gateStatusHTML = `${text}|${actions}`;
    $('#gate-text').textContent = text;
    $('#gate-actions').innerHTML = actions;
  }

  // The admin sees how many people are waiting, on the avatar and in the menu.
  function updateAdminBadge() {
    const count = sync.admin ? sync.pendingUsers : 0;
    $('#admin-item').hidden = !sync.admin;
    for (const id of ['#avatar-badge', '#admin-count']) {
      $(id).hidden = count === 0;
      $(id).textContent = count;
    }
    updateAccountLabel();
  }

  function setPendingUsers(count, { fromOverview = false } = {}) {
    const changed = count !== sync.pendingUsers;
    sync.pendingUsers = count;
    updateAdminBadge();
    if (changed && !fromOverview && admin.dialog.open) refreshAdmin();
    if (sync.admin && count > sync.notifiedPending) {
      toast(`${count} ${count === 1 ? 'person is' : 'people are'} waiting for your approval.`, {
        action: 'Review',
        onAction: openAdmin,
      });
    }
    sync.notifiedPending = count;
  }

  // Passwords must never travel over plain http.
  function ensureHttps() {
    const local = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
    if (location.protocol === 'http:' && !local) {
      location.replace(`https://${location.host}${location.pathname}${location.search}${location.hash}`);
      return false;
    }
    return true;
  }

  /* ---- sign-in form */

  const auth = { root: $('#auth'), form: $('#auth-form'), mode: 'signin', busy: false, requested: '' };
  const authField = (name) => auth.form.elements.namedItem(name);

  // Shows the sign-in page in `mode` (signin or signup), e.g. from a
  // "Sign in" button on a notice.
  function openAuth(mode = 'signin', email = '') {
    if (!ensureHttps()) return;
    auth.mode = mode;
    auth.requested = '';
    if (email) authField('email').value = email;
    authField('password').value = '';
    $('#auth-error').hidden = true;
    updateGate();
    if (!auth.root.hidden) (authField('email').value ? authField('password') : authField('email')).focus();
  }

  function switchAuthMode(mode) {
    if (mode === auth.mode) return;
    auth.mode = mode;
    $('#auth-error').hidden = true;
    renderAuthMode();
  }

  function renderAuthMode() {
    // Until an account exists, the only thing to do is create the first one.
    if (sync.first && auth.mode === 'signin') auth.mode = 'signup';
    if (auth.mode === 'signup' && !sync.signupOpen) auth.mode = 'signin';
    const signup = auth.mode === 'signup';
    const requested = auth.mode === 'requested';
    $('#auth-tabs').hidden = requested || sync.first || !sync.signupOpen;
    for (const tab of $$('#auth-tabs [role="tab"]')) {
      const selected = tab.dataset.gate === auth.mode;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    setText($('#auth-heading'), requested ? 'Request sent' : signup ? 'Create your account' : 'Sign in');
    let intro = 'Welcome back. Sign in to see your plans.';
    if (requested) intro = auth.requested;
    else if (signup && sync.first) {
      intro = "You're the first person here, so this account will be the admin, who approves everyone else.";
    } else if (signup) {
      intro = 'Your plans are saved to your account, so you can open them in any browser. The admin approves new accounts before you can sign in.';
    }
    setText($('#auth-intro'), intro);
    $('#auth-fields').hidden = requested;
    setText($('#auth-submit'), requested ? 'Back to sign in' : signup ? 'Create account' : 'Sign in');
    authField('password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    $('#auth-hint').hidden = !signup;
    setText($('#gate-note'), signup || requested ? '' : 'Forgot your password? Ask the site admin to reset it.');
  }

  function showAuthError(message) {
    const box = $('#auth-error');
    box.textContent = message;
    box.hidden = false;
  }

  async function submitAuth() {
    if (auth.busy) return;
    if (auth.mode === 'requested') {
      switchAuthMode('signin');
      authField('email').focus();
      return;
    }
    const signup = auth.mode === 'signup';
    const email = authField('email').value.trim();
    const password = authField('password').value;
    if (!email || !password) {
      showAuthError('Enter your email and password.');
      return;
    }
    if (signup && password.length < 8) {
      showAuthError('Use at least 8 characters for your password.');
      return;
    }
    auth.busy = true;
    $('#auth-submit').disabled = true;
    $('#auth-error').hidden = true;
    try {
      const result = await api(signup ? 'api/register' : 'api/login', { email, password });
      authField('password').value = '';
      if (result.pending) {
        // Later sign-ups wait for the admin: say so instead of signing in.
        if (auth.root.hidden) {
          toast(result.message); // signed in elsewhere while the request was running
          return;
        }
        auth.mode = 'requested';
        auth.requested = result.message;
        renderAuthMode();
        $('#auth-submit').disabled = false;
        $('#auth-submit').focus();
        return;
      }
      sync.first = false;
      const brought = state.plans.length;
      await startSession(result.user.email, result.user.admin);
      let message = `Signed in as ${result.user.email}.`;
      if (signup) message = `Account created. You're the admin of this site, and your plans are saved to ${result.user.email}.`;
      else if (brought) message = `Signed in. The ${brought} ${brought === 1 ? 'plan' : 'plans'} on this browser were added to your account.`;
      const waiting = sync.admin ? sync.pendingUsers : 0;
      if (waiting) {
        message += ` ${waiting} ${waiting === 1 ? 'person is' : 'people are'} waiting for your approval.`;
        toast(message, { action: 'Review', onAction: openAdmin });
      } else {
        toast(message);
      }
    } catch (err) {
      if (signup && err.status === 403) {
        // Sign-ups were stopped while this page was open.
        sync.signupOpen = false;
        auth.mode = 'signin';
        renderAuthMode();
        render();
        showAuthError(`${err.message} If you already have an account, you can sign in.`);
      } else {
        showAuthError(err.status ? err.message : "Couldn't reach the server. Check your connection and try again.");
      }
      if (!auth.root.hidden) {
        $('#auth-submit').disabled = false;
        authField(authField('email').value ? 'password' : 'email').focus();
      }
    } finally {
      auth.busy = false;
      $('#auth-submit').disabled = false;
    }
  }

  function setupAccounts() {
    auth.form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitAuth();
    });
    auth.form.addEventListener('input', () => {
      $('#auth-error').hidden = true;
    });
    // Sign in / Create account tabs; arrow keys move between them.
    const tabs = $('#auth-tabs');
    tabs.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const mode = e.key === 'ArrowLeft' || e.key === 'Home' ? 'signin' : 'signup';
      switchAuthMode(mode);
      $(`[data-gate="${mode}"]`, tabs).focus();
    });

    const menu = $('#account');
    menu.addEventListener('click', async (e) => {
      const item = e.target.closest('[data-account]');
      if (!item) return;
      menu.open = false;
      if (item.dataset.account === 'sign-out') {
        signOut();
        return;
      }
      if (item.dataset.account === 'admin') {
        openAdmin();
        return;
      }
      const waitingBefore = sync.notifiedPending;
      await syncNow();
      if (!sync.user) return; // signed out meanwhile: keep that notice visible
      if (sync.status !== 'saved') toast(SYNC_TEXT[sync.status]);
      // Don't cover a "people are waiting for approval" notice.
      else if (sync.notifiedPending <= waitingBefore) toast('Everything is up to date.');
    });
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menu.open) {
        menu.open = false;
        $('summary', menu).focus();
      }
    });

    $('#gate').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-gate]');
      if (!btn) return;
      if (btn.dataset.gate === 'retry') {
        sync.server = 'unknown';
        updateGate();
        connectToServer();
      } else {
        switchAuthMode(btn.dataset.gate);
      }
    });

    setupAdmin();
    updateAccountUI();
    connectToServer();
  }

  /* ---- admin: approve and manage accounts */

  const admin = { dialog: $('#admin'), users: [], busy: false };
  const STATUS_ORDER = { pending: 0, active: 1, disabled: 2 };
  const STATUS_NAMES = { pending: 'Waiting for approval', active: 'Active', disabled: 'Turned off' };
  const ADMIN_DONE = {
    approve: (email) => `${email} can now sign in.`,
    enable: (email) => `${email} can sign in again.`,
    disable: (email) => `${email} is turned off and signed out.`,
    delete: (email) => `Removed ${email}.`,
  };

  function openAdmin() {
    if (!sync.admin) return;
    $('#account').open = false;
    admin.users = [];
    $('#admin-error').hidden = true;
    $('#admin-signup').disabled = true; // until the real setting has loaded
    $('#admin-users').innerHTML = '<li class="user-empty muted">Loading…</li>';
    if (!admin.dialog.open) admin.dialog.showModal();
    $('#admin-heading').focus();
    refreshAdmin();
  }

  async function refreshAdmin() {
    try {
      applyAdminOverview(await api('api/admin/users'));
    } catch (err) {
      if (!admin.users.length && admin.dialog.open && err.status !== 401 && err.status !== 403) {
        admin.failed = true;
        $('#admin-users').innerHTML = `
          <li class="user-empty">Couldn't load the accounts. Check your connection.
            <button type="button" class="link" data-admin-retry>Try again</button></li>`;
        return;
      }
      adminError(err);
    }
  }

  function applyAdminOverview(data) {
    admin.failed = false;
    admin.users = data.users;
    $('#admin-error').hidden = true;
    $('#admin-signup').checked = data.signup;
    $('#admin-signup').disabled = false;
    sync.notifiedPending = data.pending; // no "people are waiting" toast while looking at them
    setPendingUsers(data.pending, { fromOverview: true });
    renderAdminUsers();
  }

  // After the list re-renders, keep keyboard focus near where it was.
  function focusAdminRow(email, index) {
    const rows = $$('#admin-users .user-row');
    const row = rows.find((r) => r.dataset.email === email) || rows[Math.min(index, rows.length - 1)];
    const target = row && row.querySelector('button');
    (target || $('#admin-heading')).focus();
  }

  function renderAdminUsers() {
    const users = [...admin.users].sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.createdAt - b.createdAt
    );
    const button = (action, label, kind) =>
      `<button type="button" class="btn small ${kind}" data-admin-action="${action}">${label}</button>`;
    const rows = users.map((u) => {
      const self = u.email === sync.user;
      const date = new Date(u.createdAt * 1000).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      const meta = u.status === 'pending' ? `Asked on ${date}` : `Joined ${date} · ${u.plans} ${u.plans === 1 ? 'plan' : 'plans'}`;
      let actions = '';
      if (!self && u.status === 'pending') actions = button('approve', 'Approve', 'primary') + button('delete', 'Decline', 'ghost');
      else if (!self && u.status === 'active') actions = button('disable', 'Turn off', 'ghost');
      else if (!self) actions = button('enable', 'Turn on', 'ghost') + button('delete', 'Delete', 'danger');
      return `
        <li class="user-row st-${u.status}" data-email="${esc(u.email)}">
          <div class="user-main">
            <strong class="user-email">${esc(u.email)}</strong>
            <span class="user-meta">${esc(meta)}</span>
          </div>
          <div class="user-tags">
            ${self ? '<span class="status-chip st-you">You</span>' : ''}
            ${u.admin ? '<span class="status-chip st-admin">Admin</span>' : ''}
            ${self ? '' : `<span class="status-chip st-${u.status}">${STATUS_NAMES[u.status]}</span>`}
          </div>
          ${actions ? `<div class="user-actions">${actions}</div>` : ''}
        </li>`;
    });
    const alone = !users.some((u) => u.email !== sync.user);
    $('#admin-users').innerHTML =
      rows.join('') +
      (alone
        ? '<li class="user-empty muted">No one else has an account yet. When people sign up, they appear here for you to approve.</li>'
        : '');
  }

  function adminError(err) {
    if (err.status === 401) {
      admin.dialog.close();
      signedOutElsewhere();
      return;
    }
    const message = err.status ? err.message : "Couldn't reach the server. Check your connection and try again.";
    if (err.status === 403) {
      admin.dialog.close();
      sync.admin = false;
      saveSyncState();
      updateAccountUI();
      toast(message);
      return;
    }
    const box = $('#admin-error');
    box.textContent = message;
    box.hidden = false;
    if (err.status === 404) refreshAdmin(); // someone else changed the list
  }

  function setupAdmin() {
    for (const btn of $$('#admin [data-close]')) btn.addEventListener('click', () => admin.dialog.close());
    admin.dialog.addEventListener('close', () => {
      if (!$('#account').hidden) $('#account summary').focus();
    });
    window.addEventListener('online', () => {
      if (admin.dialog.open && admin.failed) refreshAdmin();
    });

    $('#admin-users').addEventListener('click', async (e) => {
      if (e.target.closest('[data-admin-retry]')) {
        $('#admin-users').innerHTML = '<li class="user-empty muted">Loading…</li>';
        refreshAdmin();
        return;
      }
      const btn = e.target.closest('[data-admin-action]');
      if (!btn || admin.busy) return;
      const rowIndex = $$('#admin-users .user-row').indexOf(btn.closest('.user-row'));
      const email = btn.closest('[data-email]').dataset.email;
      const action = btn.dataset.adminAction;
      const user = admin.users.find((u) => u.email === email);
      if (action === 'delete') {
        const question =
          user && user.status === 'pending'
            ? `Decline the request from ${email}?`
            : `Delete ${email} and all of their plans? This can't be undone.`;
        if (!window.confirm(question)) return;
      }
      admin.busy = true;
      btn.disabled = true;
      try {
        applyAdminOverview(await api('api/admin/users', { email, action }));
        focusAdminRow(email, rowIndex);
        const declined = action === 'delete' && user && user.status === 'pending';
        toast(declined ? `Declined the request from ${email}.` : ADMIN_DONE[action](email));
      } catch (err) {
        btn.disabled = false;
        adminError(err);
      } finally {
        admin.busy = false;
      }
    });

    $('#admin-signup').addEventListener('change', async (e) => {
      const wanted = e.target.checked;
      try {
        applyAdminOverview(await api('api/admin/settings', { signup: wanted }));
        sync.signupOpen = wanted;
        toast(wanted ? 'People can ask for an account again.' : 'New sign-ups are stopped.');
      } catch (err) {
        e.target.checked = !wanted;
        adminError(err);
      }
    });
  }

  let connectDelay = 0;
  let connectTimer = null;

  async function connectToServer() {
    if (location.protocol === 'file:') return;
    if (readStorage(LOGOUT_KEY)) {
      try {
        await api('api/logout', {});
        removeStorage(LOGOUT_KEY);
      } catch {
        /* still offline; try again next time */
      }
    }
    let me;
    try {
      me = await api('api/me');
    } catch (err) {
      if (err.status === 404) {
        sync.server = 'none'; // no accounts on this server (e.g. static hosting)
        updateGate();
        return;
      }
      // Offline or a server hiccup: keep working, say so, and try again.
      if (sync.server !== 'ok') sync.server = 'unreachable';
      updateGate();
      if (sync.user) {
        sync.available = true;
        updateAccountUI();
        setSyncStatus(err.status ? 'error' : 'offline');
      }
      connectDelay = Math.min(connectDelay ? connectDelay * 2 : 10000, 5 * 60 * 1000);
      clearTimeout(connectTimer);
      connectTimer = setTimeout(connectToServer, connectDelay);
      return;
    }
    connectDelay = 0;
    sync.connected = true;
    sync.available = true;
    sync.server = 'ok';
    sync.signupOpen = Boolean(me && me.signup);
    sync.first = Boolean(me && me.first);
    if (!ensureHttps()) return;

    const serverUser = me && me.user ? me.user.email : '';
    if (serverUser && serverUser === sync.user) {
      sync.admin = Boolean(me.user.admin);
      saveSyncState();
      updateAccountUI();
      render();
      if (typeof me.pending === 'number') setPendingUsers(me.pending);
      syncNow();
    } else if (serverUser && !sync.user) {
      await startSession(serverUser, me.user.admin);
    } else if (sync.user) {
      signedOutElsewhere();
    } else {
      updateAccountUI();
      render();
    }
  }

  /* --------------------------------------------------------------- events */

  function setupViewEvents() {
    const view = $('#view');

    view.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el || !view.contains(el)) return;
      const id = el.closest('[data-id]')?.dataset.id;
      switch (el.dataset.action) {
        case 'edit': {
          const plan = findPlan(id);
          if (plan) openEditor(plan);
          break;
        }
        case 'cycle': {
          const plan = findPlan(id);
          if (plan) changeStatus(id, C.nextStatus(plan.status, plan.kind), el);
          break;
        }
        case 'set-status':
          changeStatus(id, el.dataset.status, el);
          break;
        case 'filter-tag':
          setTagFilter(el.dataset.tag);
          break;
        case 'new':
          openEditor(null, {
            status: el.dataset.status || 'todo',
            dueDate: el.dataset.date || '',
            kind: el.dataset.kind || 'plan',
          });
          break;
        case 'samples':
          addSamples();
          break;
        case 'go':
          setView(el.dataset.view);
          break;
        case 'clear-filters':
          clearFilters();
          break;
        case 'select-day':
          selectDay(el.dataset.date);
          break;
        case 'cal-prev':
          shiftMonth(-1);
          break;
        case 'cal-next':
          shiftMonth(1);
          break;
        case 'cal-today': {
          const now = new Date();
          state.calendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
          state.selectedDay = C.toISODate(now);
          render();
          break;
        }
        default:
      }
    });

    view.addEventListener(
      'toggle',
      (e) => {
        const section = e.target.dataset && e.target.dataset.section;
        if (!section) return;
        if (e.target.open) state.openSections.add(section);
        else state.openSections.delete(section);
      },
      true
    );

    view.addEventListener('dblclick', (e) => {
      const day = e.target.closest('.cal-day');
      if (day && !e.target.closest('.cal-chip')) openEditor(null, { dueDate: day.dataset.date });
    });

    view.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('.card')) {
        e.preventDefault();
        const plan = findPlan(e.target.dataset.id);
        if (plan) openEditor(plan);
      }
    });
  }

  function clearFilters() {
    state.filters = { query: '', tag: '', priority: '', kind: '' };
    $('#search').value = '';
    render();
  }

  function setupFilters() {
    const box = $('#filters');
    box.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      if (el.dataset.action === 'filter-tag') setTagFilter(el.dataset.tag);
      if (el.dataset.action === 'clear-filters') clearFilters();
    });
    box.addEventListener('change', (e) => {
      const which = e.target.dataset.filter;
      if (which === 'priority') state.filters.priority = e.target.value;
      if (which === 'kind') state.filters.kind = e.target.value;
      if (which === 'sort') {
        state.prefs.sort = e.target.value;
        savePrefs();
      }
      render();
    });

    const search = $('#search');
    search.addEventListener('input', () => {
      state.filters.query = search.value;
      render();
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        search.value = '';
        state.filters.query = '';
        render();
        search.blur();
      }
    });
  }

  function setupGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('dialog[open]') || document.body.classList.contains('gated')) return;
      if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      switch (e.key) {
        case 'n':
        case 'N':
          e.preventDefault();
          $('#qa-input').focus();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          openNewMeeting();
          break;
        case '/':
          e.preventDefault();
          $('#search').focus();
          break;
        case '1':
        case '2':
        case '3':
          setView(VIEWS[Number(e.key) - 1]);
          break;
        case '[':
        case ']':
          if (state.prefs.view === 'calendar') shiftMonth(e.key === ']' ? 1 : -1);
          break;
        case 'd':
        case 'D':
          toggleTheme();
          break;
        case '?':
          $('#shortcuts').showModal();
          break;
        default:
      }
    });
  }

  function init() {
    applyTheme();
    const narrow = window.matchMedia('(max-width: 640px)');
    const setPlaceholder = () => {
      $('#qa-input').placeholder = narrow.matches
        ? 'Add a plan, e.g. “Gym tomorrow 7am”'
        : 'Add a plan… try “Finish report fri 3pm #work !high”';
    };
    setPlaceholder();
    narrow.addEventListener('change', setPlaceholder);
    for (const tab of $$('.view-tab')) tab.addEventListener('click', () => setView(tab.dataset.view));
    for (const brand of $$('.shell .brand')) {
      brand.addEventListener('click', (e) => {
        e.preventDefault();
        setView('today');
      });
    }
    $('#new-meeting').addEventListener('click', openNewMeeting);
    $('#new-plan').addEventListener('click', () =>
      openEditor(null, state.prefs.view === 'calendar' ? { dueDate: state.selectedDay } : {})
    );
    $('#sidebar-tags').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tag]');
      if (btn) setTagFilter(btn.dataset.tag);
    });
    for (const btn of $$('[data-open="shortcuts"]')) btn.addEventListener('click', () => $('#shortcuts').showModal());
    $('#theme-toggle').addEventListener('click', toggleTheme);
    $('#toast').addEventListener('mouseenter', () => clearTimeout(toastTimer));
    $('#toast').addEventListener('mouseleave', () => {
      toastTimer = setTimeout(hideToast, toastDuration);
    });

    setupQuickAdd();
    setupEditor();
    setupMenu();
    setupFilters();
    setupViewEvents();
    setupDragAndDrop();
    setupGlobalKeys();

    // Keep other tabs in sync and refresh relative deadlines over time.
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) {
        state.plans = loadPlans(state.plans);
        // A tab still running an older version saved over the meeting details:
        // store them again (this tab still had them), then check the account.
        if (restoredOnLoad) savePlans();
        if (state.dragId) state.renderAfterDrag = true;
        else render();
        if (olderDataLoads > olderDataPulled) syncNow();
      }
      if (e.key === SYNC_KEY) adoptSyncStateFromOtherTab();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      render();
      syncNow();
    });
    window.addEventListener('online', () => {
      if (sync.connected) syncNow();
      else connectToServer();
    });
    setInterval(() => {
      if (document.hidden || state.dragId) return;
      render();
      syncNow();
    }, 60 * 1000);

    loadSyncState();
    setupAccounts();
    render();
    if (loadProblem) toast(loadProblem);
  }

  init();
})();
