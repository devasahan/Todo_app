/*
 * Dayplan core: pure logic with no DOM access.
 * Loaded as a plain <script> in the browser (exposes window.PlanCore)
 * and through require() in the Node test suite.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlanCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATUSES = ['todo', 'in_progress', 'done'];
  const STATUS_LABELS = { todo: 'To do', in_progress: 'In progress', done: 'Done' };
  const PRIORITIES = ['low', 'medium', 'high'];
  const PRIORITY_LABELS = { low: 'Low', medium: 'Medium', high: 'High' };
  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
  const DAY_MS = 24 * 60 * 60 * 1000;

  /* ------------------------------------------------------------------ ids */

  function uid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* ---------------------------------------------------------------- dates */

  const pad = (n) => String(n).padStart(2, '0');

  // Dates are stored as local "YYYY-MM-DD" strings so a deadline never
  // shifts when the browser's time zone changes.
  function toISODate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function parseISODate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
    if (!m) return null;
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    // Rejects impossible dates such as 2026-02-31.
    return date.getMonth() === Number(m[2]) - 1 && date.getDate() === Number(m[3]) ? date : null;
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function addDays(date, days) {
    const d = startOfDay(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  function addMonths(date, months) {
    const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(date.getDate(), lastDay));
    return target;
  }

  // Whole calendar days from `from` to `to` (DST-safe thanks to rounding).
  function daysBetween(from, to) {
    return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
  }

  function isValidTime(value) {
    return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  }

  function minutesOf(time) {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  function formatTime(time) {
    const [h, m] = time.split(':').map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatDate(date, now = new Date()) {
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return date.toLocaleDateString(undefined, opts);
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  /*
   * Describes how close a plan's deadline is.
   * state: none | overdue | today | soon | later | done
   */
  function dueInfo(plan, now = new Date()) {
    const due = parseISODate(plan.dueDate);
    if (!due) return { state: 'none', label: 'No deadline', full: '', days: null };

    const days = daysBetween(now, due);
    const hasTime = isValidTime(plan.dueTime);
    const at = hasTime ? ` at ${formatTime(plan.dueTime)}` : '';
    const full = `${formatDate(due, now)}${at}`;
    const info = (state, label) => ({ state, label, full, days });

    if (plan.status === 'done') return info('done', `Due ${formatDate(due, now)}`);
    if (days < 0) return info('overdue', `Overdue by ${plural(-days, 'day')}`);
    if (days === 0) {
      const passed = hasTime && minutesOf(plan.dueTime) < now.getHours() * 60 + now.getMinutes();
      return passed
        ? info('overdue', `Overdue since ${formatTime(plan.dueTime)}`)
        : info('today', `Due today${at}`);
    }
    if (days === 1) return info('soon', `Due tomorrow${at}`);
    if (days < 7) {
      const weekday = due.toLocaleDateString(undefined, { weekday: 'long' });
      return info(days <= 3 ? 'soon' : 'later', `Due ${weekday}${at}`);
    }
    return info('later', `Due ${formatDate(due, now)}`);
  }

  /* ------------------------------------------------------------ quick add */

  const WEEKDAYS = {
    sunday: 0, sun: 0,
    monday: 1, mon: 1,
    tuesday: 2, tues: 2, tue: 2,
    wednesday: 3, weds: 3, wed: 3,
    thursday: 4, thurs: 4, thur: 4, thu: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6,
  };
  // Abbreviations that are also ordinary words ("enjoy the sun") only count
  // as dates after a hint word such as "on" or "by".
  const AMBIGUOUS_DAYS = new Set(['sun', 'wed', 'sat']);

  const MONTHS = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
    may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
    september: 8, sept: 8, sep: 8, october: 9, oct: 9, november: 10, nov: 10,
    december: 11, dec: 11,
  };

  const NUMBER_WORDS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };

  const PRIORITY_TOKENS = {
    '!!!': 'high', '!high': 'high', '!h': 'high', p1: 'high',
    '!!': 'medium', '!medium': 'medium', '!med': 'medium', '!m': 'medium', p2: 'medium',
    '!low': 'low', '!l': 'low', p3: 'low',
  };

  const START = '(?:^|\\s)';
  const END = '(?=$|[\\s,.;!?])';
  const HINT = '(?:(on|by|due|before|this|next)\\s+)?';
  const alternation = (words) => Object.keys(words).sort((a, b) => b.length - a.length).join('|');
  const rx = (source) => new RegExp(START + source + END, 'gi');

  const RE = {
    tag: /(?:^|\s)#([\p{L}\p{N}_-]+)/gu,
    priority: rx('(!!!|!!|![a-z]+|p[1-3])'),
    time12: rx('(?:at\\s+|@\\s?)?(\\d{1,2})(?::([0-5]\\d))?\\s?(am|pm)'),
    time24: rx('(?:at\\s+|@\\s?)?([01]?\\d|2[0-3]):([0-5]\\d)'),
    noon: rx('(?:at\\s+)?(noon|midday)'),
    isoDate: rx('(?:(?:on|by|due|before)\\s+)?(\\d{4})-(\\d{2})-(\\d{2})'),
    monthDay: rx(`(?:(?:on|by|due|before)\\s+)?(${alternation(MONTHS)})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?`),
    dayMonth: rx(`(?:(?:on|by|due|before)\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${alternation(MONTHS)})`),
    relative: rx(`in\\s+(\\d{1,3}|${alternation(NUMBER_WORDS)})\\s+(days?|weeks?|months?)`),
    named: rx('(?:(?:on|by|due|before)\\s+)?(today|tonight|tomorrow|tmrw|tmr)'),
    period: rx('(?:(?:by|due|before)\\s+)?(next\\s+week|next\\s+month|this\\s+weekend|weekend|end\\s+of\\s+(?:the\\s+)?week|eow)'),
    weekday: rx(`${HINT}(${alternation(WEEKDAYS)})`),
  };

  /*
   * Turns "Finish report fri 3pm #work !high" into structured fields.
   * Recognised pieces are removed from the title.
   */
  function parseQuickAdd(input, now = new Date()) {
    let rest = ` ${String(input || '')} `;
    const today = startOfDay(now);

    // Returns the first match `read` accepts and cuts it out of the text.
    const take = (re, read) => {
      for (const m of rest.matchAll(re)) {
        const value = read(m);
        if (value !== null && value !== undefined) {
          rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
          return value;
        }
      }
      return null;
    };

    const tags = [];
    let tag;
    while ((tag = take(RE.tag, (m) => normalizeTag(m[1]) || null)) !== null) {
      if (!tags.includes(tag)) tags.push(tag);
    }

    const priority = take(RE.priority, (m) => PRIORITY_TOKENS[m[1].toLowerCase()] || null);

    let time =
      take(RE.time12, (m) => {
        let h = Number(m[1]);
        if (h < 1 || h > 12) return null;
        const pm = m[3].toLowerCase() === 'pm';
        if (pm && h !== 12) h += 12;
        if (!pm && h === 12) h = 0;
        return `${pad(h)}:${m[2] || '00'}`;
      }) ??
      take(RE.time24, (m) => `${pad(Number(m[1]))}:${m[2]}`) ??
      take(RE.noon, () => '12:00');

    let tonight = false;
    const monthDate = (month, day) => {
      let date = new Date(today.getFullYear(), month, day);
      if (date.getMonth() !== month) return null;
      if (date < today) date = new Date(today.getFullYear() + 1, month, day);
      return date;
    };

    let date =
      take(RE.isoDate, (m) => parseISODate(`${m[1]}-${m[2]}-${m[3]}`)) ??
      take(RE.monthDay, (m) => monthDate(MONTHS[m[1].toLowerCase()], Number(m[2]))) ??
      take(RE.dayMonth, (m) => monthDate(MONTHS[m[2].toLowerCase()], Number(m[1]))) ??
      take(RE.relative, (m) => {
        const raw = m[1].toLowerCase();
        const n = NUMBER_WORDS[raw] ?? Number(raw);
        const unit = m[2].toLowerCase();
        if (unit.startsWith('day')) return addDays(today, n);
        if (unit.startsWith('week')) return addDays(today, n * 7);
        return addMonths(today, n);
      }) ??
      take(RE.named, (m) => {
        const word = m[1].toLowerCase();
        if (word === 'today') return today;
        if (word === 'tonight') {
          tonight = true;
          return today;
        }
        return addDays(today, 1);
      }) ??
      take(RE.period, (m) => {
        const word = m[1].toLowerCase().replace(/\s+/g, ' ');
        const dow = today.getDay();
        if (word === 'next week') return addDays(today, (1 - dow + 7) % 7 || 7);
        if (word === 'next month') return new Date(today.getFullYear(), today.getMonth() + 1, 1);
        if (word.includes('weekend')) return addDays(today, dow === 0 ? 0 : 6 - dow);
        return addDays(today, (5 - dow + 7) % 7); // end of week = Friday
      }) ??
      take(RE.weekday, (m) => {
        const hint = (m[1] || '').toLowerCase();
        const word = m[2].toLowerCase();
        if (AMBIGUOUS_DAYS.has(word) && !hint) return null;
        let diff = (WEEKDAYS[word] - today.getDay() + 7) % 7;
        if (hint === 'next' && diff === 0) diff = 7;
        return addDays(today, diff);
      });

    if (tonight && !time) time = '20:00';
    if (time && !date) {
      // "call mom 9am" typed after 9am means tomorrow morning.
      const passed = minutesOf(time) <= now.getHours() * 60 + now.getMinutes();
      date = passed ? addDays(today, 1) : today;
    }

    return {
      title: rest.replace(/\s+/g, ' ').trim(),
      dueDate: date ? toISODate(date) : '',
      dueTime: date && time ? time : '',
      priority: priority || '',
      tags,
    };
  }

  /* ---------------------------------------------------------------- plans */

  function normalizeTag(value) {
    return String(value || '')
      .trim()
      .replace(/^#+/, '')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}_-]/gu, '')
      .slice(0, 30);
  }

  const isStamp = (v) => typeof v === 'string' && v !== '' && !Number.isNaN(Date.parse(v));
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

  // Validates and fills in any plan-shaped object (also used for imports).
  function normalizePlan(raw, now = new Date()) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const stamp = now.toISOString();
    const status = STATUSES.includes(r.status) ? r.status : 'todo';
    const dueDate = parseISODate(r.dueDate) ? r.dueDate : '';
    const updatedAt = isStamp(r.updatedAt) ? r.updatedAt : stamp;

    const tags = Array.isArray(r.tags) ? r.tags.map(normalizeTag).filter(Boolean) : [];
    const checklist = Array.isArray(r.checklist)
      ? r.checklist
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            id: text(item.id, 100) || uid(),
            text: text(item.text, 300).trim(),
            done: Boolean(item.done),
          }))
          .filter((item) => item.text)
      : [];

    return {
      id: text(r.id, 100) || uid(),
      title: text(r.title, 200).trim() || 'Untitled plan',
      description: text(r.description, 5000),
      dueDate,
      dueTime: dueDate && isValidTime(r.dueTime) ? r.dueTime : '',
      status,
      priority: PRIORITIES.includes(r.priority) ? r.priority : 'medium',
      tags: [...new Set(tags)].slice(0, 20),
      checklist,
      order: Number.isFinite(r.order) ? r.order : 0,
      createdAt: isStamp(r.createdAt) ? r.createdAt : stamp,
      updatedAt,
      startedAt: isStamp(r.startedAt) ? r.startedAt : '',
      completedAt: status === 'done' ? (isStamp(r.completedAt) ? r.completedAt : updatedAt) : '',
    };
  }

  // Creates a new plan at the top of its status column.
  function createPlan(fields, plans = [], now = new Date()) {
    const status = STATUSES.includes(fields.status) ? fields.status : 'todo';
    const peers = plans.filter((p) => p.status === status).map((p) => p.order);
    const stamp = now.toISOString();
    return normalizePlan(
      {
        ...fields,
        id: uid(),
        status,
        order: peers.length ? Math.min(...peers) - 1 : 0,
        createdAt: stamp,
        updatedAt: stamp,
        startedAt: status === 'in_progress' ? stamp : '',
        completedAt: status === 'done' ? stamp : '',
      },
      now
    );
  }

  // Returns a copy of the plan in the new status, keeping timestamps honest.
  function withStatus(plan, status, now = new Date()) {
    if (!STATUSES.includes(status) || plan.status === status) return plan;
    const stamp = now.toISOString();
    return {
      ...plan,
      status,
      updatedAt: stamp,
      startedAt: status === 'todo' ? '' : plan.startedAt || (status === 'in_progress' ? stamp : ''),
      completedAt: status === 'done' ? stamp : '',
    };
  }

  function nextStatus(status) {
    return STATUSES[(STATUSES.indexOf(status) + 1) % STATUSES.length];
  }

  /*
   * Moves a plan into `toStatus`, placed before `beforeId` (or at the end),
   * and renumbers that column so manual ordering stays stable.
   */
  function movePlan(plans, id, toStatus, beforeId = null, now = new Date()) {
    const plan = plans.find((p) => p.id === id);
    if (!plan || !STATUSES.includes(toStatus)) return plans;

    const column = plans
      .filter((p) => p.status === toStatus && p.id !== id)
      .sort((a, b) => a.order - b.order);
    let index = beforeId ? column.findIndex((p) => p.id === beforeId) : -1;
    if (index < 0) index = column.length;

    const moved = withStatus(plan, toStatus, now);
    column.splice(index, 0, moved);
    const orders = new Map(column.map((p, i) => [p.id, i]));

    return plans.map((p) => {
      const base = p.id === id ? moved : p;
      return orders.has(p.id) && base.order !== orders.get(p.id)
        ? { ...base, order: orders.get(p.id) }
        : base;
    });
  }

  function checklistProgress(plan) {
    const total = plan.checklist.length;
    const done = plan.checklist.filter((item) => item.done).length;
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  /* ---------------------------------------------------- filtering/sorting */

  function matchesFilters(plan, filters = {}) {
    const { query = '', tag = '', priority = '' } = filters;
    if (tag && !plan.tags.includes(tag)) return false;
    if (priority && plan.priority !== priority) return false;
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const haystack = [
      plan.title,
      plan.description,
      ...plan.tags.map((t) => `#${t}`),
      ...plan.checklist.map((item) => item.text),
    ]
      .join('\n')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  }

  // Timed deadlines sort before all-day ones; no deadline sorts last.
  function deadlineKey(plan) {
    return plan.dueDate ? `${plan.dueDate} ${plan.dueTime || '24:00'}` : '~';
  }

  function byDeadline(a, b) {
    const ka = deadlineKey(a);
    const kb = deadlineKey(b);
    // Plain comparison on purpose: localeCompare would sort "~" before digits.
    return (ka < kb ? -1 : ka > kb ? 1 : 0) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  }

  function sortPlans(plans, mode = 'manual') {
    const list = [...plans];
    const byOrder = (a, b) => a.order - b.order;
    switch (mode) {
      case 'deadline':
        return list.sort((a, b) => byDeadline(a, b) || byOrder(a, b));
      case 'priority':
        return list.sort(
          (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byDeadline(a, b) || byOrder(a, b)
        );
      case 'newest':
        return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      default:
        return list.sort(byOrder);
    }
  }

  function allTags(plans) {
    const counts = new Map();
    for (const plan of plans) for (const t of plan.tags) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }

  /* ----------------------------------------------------------- today/stats */

  function completedOn(plan) {
    return plan.status === 'done' && plan.completedAt ? toISODate(new Date(plan.completedAt)) : '';
  }

  // Splits plans into the sections of the Today view. Each open plan lands
  // in the first section it qualifies for.
  function groupForToday(plans, now = new Date()) {
    const todayKey = toISODate(now);
    const groups = { overdue: [], today: [], inProgress: [], upcoming: [], doneToday: [], later: [] };

    for (const plan of plans) {
      if (plan.status === 'done') {
        if (completedOn(plan) === todayKey) groups.doneToday.push(plan);
        continue;
      }
      const due = dueInfo(plan, now);
      if (due.state === 'overdue') groups.overdue.push(plan);
      else if (due.state === 'today') groups.today.push(plan);
      else if (plan.status === 'in_progress') groups.inProgress.push(plan);
      else if (due.days !== null && due.days <= 7) groups.upcoming.push(plan);
      else groups.later.push(plan);
    }

    for (const key of ['overdue', 'today', 'inProgress', 'upcoming', 'later']) {
      groups[key].sort((a, b) => byDeadline(a, b) || a.order - b.order);
    }
    groups.doneToday.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    return groups;
  }

  // The single plan that deserves attention right now.
  function nextUp(plans, now = new Date()) {
    const g = groupForToday(plans, now);
    return g.overdue[0] || g.today[0] || g.inProgress[0] || g.upcoming[0] || null;
  }

  function computeStats(plans, now = new Date()) {
    const todayKey = toISODate(now);
    const weekAgo = toISODate(addDays(now, -6));
    const doneDays = new Set();
    const stats = {
      total: plans.length,
      todo: 0,
      in_progress: 0,
      done: 0,
      overdue: 0,
      dueToday: 0,
      doneToday: 0,
      doneThisWeek: 0,
      streak: 0,
    };

    for (const plan of plans) {
      stats[plan.status] += 1;
      const day = completedOn(plan);
      if (day) {
        doneDays.add(day);
        if (day === todayKey) stats.doneToday += 1;
        if (day >= weekAgo && day <= todayKey) stats.doneThisWeek += 1;
      } else if (plan.status !== 'done') {
        const due = dueInfo(plan, now);
        if (due.state === 'overdue') stats.overdue += 1;
        if (plan.dueDate === todayKey) stats.dueToday += 1;
      }
    }

    // A streak survives until the end of today, so start from yesterday
    // when nothing has been finished yet today.
    let cursor = doneDays.has(todayKey) ? startOfDay(now) : addDays(now, -1);
    while (doneDays.has(toISODate(cursor))) {
      stats.streak += 1;
      cursor = addDays(cursor, -1);
    }

    // Today's progress: finished today vs. still due (or overdue) today.
    const remaining = plans.filter((p) => p.status !== 'done' && p.dueDate && p.dueDate <= todayKey).length;
    stats.todayTotal = stats.doneToday + remaining;
    stats.todayPct = stats.todayTotal ? Math.round((stats.doneToday / stats.todayTotal) * 100) : 0;
    return stats;
  }

  /* ------------------------------------------------------------- calendar */

  // 6 weeks x 7 days covering the month, starting on `weekStart` (0 = Sunday).
  function monthGrid(year, month, weekStart = 1) {
    const first = new Date(year, month, 1);
    const offset = (first.getDay() - weekStart + 7) % 7;
    const start = addDays(first, -offset);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }

  /* ------------------------------------------------------------------ sync */

  // Ids of plans that were added, changed or removed between two snapshots.
  // Plans are updated immutably, so an unchanged plan keeps its identity.
  function changedPlanIds(before, after) {
    const previous = new Map(before.map((p) => [p.id, p]));
    const ids = new Set();
    for (const plan of after) {
      if (previous.get(plan.id) !== plan) ids.add(plan.id);
      previous.delete(plan.id);
    }
    for (const id of previous.keys()) ids.add(id);
    return ids;
  }

  // Applies changes from the server. `data: null` means deleted. Plans with
  // local edits that haven't been sent yet (`skip`) keep the local version.
  function applyRemoteChanges(plans, changes, skip = new Set(), now = new Date()) {
    const byId = new Map(plans.map((p) => [p.id, p]));
    let changed = false;
    for (const change of changes) {
      if (!change || typeof change.id !== 'string' || skip.has(change.id)) continue;
      if (change.data === null || change.data === undefined) {
        if (byId.delete(change.id)) changed = true;
        continue;
      }
      const incoming = normalizePlan({ ...change.data, id: change.id }, now);
      const current = byId.get(change.id);
      if (current && JSON.stringify(current) === JSON.stringify(incoming)) continue;
      byId.set(change.id, incoming);
      changed = true;
    }
    return changed ? [...byId.values()] : plans;
  }

  /* --------------------------------------------------------- import/export */

  function exportData(plans, now = new Date()) {
    return { app: 'dayplan', version: 1, exportedAt: now.toISOString(), plans };
  }

  function importData(input, now = new Date()) {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    const list = Array.isArray(data) ? data : data && Array.isArray(data.plans) ? data.plans : null;
    if (!list) throw new Error('This file does not contain any plans.');
    const seen = new Set();
    return list
      .filter((item) => item && typeof item === 'object')
      .map((item) => normalizePlan(item, now))
      .filter((plan) => !seen.has(plan.id) && seen.add(plan.id));
  }

  function samplePlans(now = new Date()) {
    const day = (n) => toISODate(addDays(now, n));
    const ago = (hours) => new Date(now.getTime() - hours * 3600 * 1000).toISOString();
    const step = (t, done = false) => ({ text: t, done });
    const samples = [
      {
        title: 'Plan the week',
        description: 'Look at the calendar, pick the three things that matter most and block time for them.',
        dueDate: day(0),
        dueTime: '09:30',
        status: 'done',
        priority: 'medium',
        tags: ['routine'],
        checklist: [step('Review last week', true), step('Pick top 3 goals', true), step('Block focus time', true)],
        completedAt: ago(1),
      },
      {
        title: 'Finish quarterly report',
        description: 'Numbers are in the shared sheet. Keep it to two pages.',
        dueDate: day(1),
        dueTime: '17:00',
        status: 'in_progress',
        priority: 'high',
        tags: ['work'],
        checklist: [step('Collect numbers', true), step('Write summary', true), step('Make charts'), step('Send for review')],
        startedAt: ago(26),
      },
      {
        title: 'Reply to client emails',
        dueDate: day(0),
        dueTime: '16:00',
        status: 'todo',
        priority: 'medium',
        tags: ['work'],
      },
      {
        title: 'Renew gym membership',
        dueDate: day(-1),
        status: 'todo',
        priority: 'low',
        tags: ['personal'],
      },
      {
        title: 'Prepare team presentation',
        description: 'Demo of the new planning flow for Friday sync.',
        dueDate: day(4),
        status: 'todo',
        priority: 'high',
        tags: ['work'],
        checklist: [step('Outline'), step('Slides'), step('Rehearse once')],
      },
      {
        title: 'Read 20 pages',
        status: 'todo',
        priority: 'low',
        tags: ['personal', 'learning'],
      },
    ];
    return samples.map((fields, i) =>
      normalizePlan({ ...fields, id: uid(), order: i, createdAt: ago(48 - i), updatedAt: ago(1) }, now)
    );
  }

  return {
    STATUSES,
    STATUS_LABELS,
    PRIORITIES,
    PRIORITY_LABELS,
    uid,
    toISODate,
    parseISODate,
    startOfDay,
    addDays,
    addMonths,
    daysBetween,
    isValidTime,
    formatTime,
    formatDate,
    dueInfo,
    parseQuickAdd,
    normalizeTag,
    normalizePlan,
    createPlan,
    withStatus,
    nextStatus,
    movePlan,
    checklistProgress,
    matchesFilters,
    sortPlans,
    allTags,
    groupForToday,
    nextUp,
    computeStats,
    monthGrid,
    changedPlanIds,
    applyRemoteChanges,
    exportData,
    importData,
    samplePlans,
  };
});
