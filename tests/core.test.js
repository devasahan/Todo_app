const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

// Wednesday, 14 October 2026, 10:00 local time.
const NOW = new Date(2026, 9, 14, 10, 0);

const plan = (fields = {}) => C.normalizePlan({ title: 'Plan', ...fields }, NOW);

test('dates round-trip as local YYYY-MM-DD strings', () => {
  assert.equal(C.toISODate(NOW), '2026-10-14');
  assert.equal(C.toISODate(C.parseISODate('2026-03-09')), '2026-03-09');
  assert.equal(C.parseISODate('2026-02-31'), null);
  assert.equal(C.parseISODate('not a date'), null);
  assert.equal(C.daysBetween(NOW, C.parseISODate('2026-10-20')), 6);
  assert.equal(C.toISODate(C.addMonths(new Date(2026, 0, 31), 1)), '2026-02-28');
});

test('quick add pulls deadline, time, priority and tags out of the title', () => {
  assert.deepEqual(C.parseQuickAdd('Finish report fri 3pm #work !high', NOW), {
    title: 'Finish report',
    dueDate: '2026-10-16',
    dueTime: '15:00',
    priority: 'high',
    tags: ['work'],
  });
});

test('quick add understands common date phrases', () => {
  const cases = {
    'a today': '2026-10-14',
    'a tomorrow': '2026-10-15',
    'a tmrw': '2026-10-15',
    'a in 3 days': '2026-10-17',
    'a in two weeks': '2026-10-28',
    'a in a month': '2026-11-14',
    'a next week': '2026-10-19',
    'a next month': '2026-11-01',
    'a this weekend': '2026-10-17',
    'a eow': '2026-10-16',
    'a monday': '2026-10-19',
    'a wednesday': '2026-10-14',
    'a next wednesday': '2026-10-21',
    'a by fri': '2026-10-16',
    'a oct 31': '2026-10-31',
    'a 3rd of november': '2026-11-03',
    'a jan 5': '2027-01-05',
    'a 2026-12-01': '2026-12-01',
  };
  for (const [input, expected] of Object.entries(cases)) {
    const result = C.parseQuickAdd(input, NOW);
    assert.equal(result.dueDate, expected, input);
    assert.equal(result.title, 'a', input);
  }
});

test('quick add handles times', () => {
  assert.equal(C.parseQuickAdd('a 9:30am tomorrow', NOW).dueTime, '09:30');
  assert.equal(C.parseQuickAdd('a 12am tomorrow', NOW).dueTime, '00:00');
  assert.equal(C.parseQuickAdd('a 12pm tomorrow', NOW).dueTime, '12:00');
  assert.equal(C.parseQuickAdd('a at 18:45 today', NOW).dueTime, '18:45');
  assert.equal(C.parseQuickAdd('a noon friday', NOW).dueTime, '12:00');

  const tonight = C.parseQuickAdd('gym tonight', NOW);
  assert.deepEqual([tonight.dueDate, tonight.dueTime], ['2026-10-14', '20:00']);

  // A time with no date means today, or tomorrow once that time has passed.
  assert.equal(C.parseQuickAdd('call 3pm', NOW).dueDate, '2026-10-14');
  assert.equal(C.parseQuickAdd('call 9am', NOW).dueDate, '2026-10-15');
});

test('quick add leaves ordinary words alone', () => {
  for (const input of ['enjoy the sun', 'sat exam prep', "Tomorrow's agenda", 'buy 5 apples', 'may need help']) {
    const result = C.parseQuickAdd(input, NOW);
    assert.equal(result.title, input);
    assert.equal(result.dueDate, '');
  }
  assert.equal(C.parseQuickAdd('lunch on sat', NOW).dueDate, '2026-10-17');
});

test('quick add priorities and tags', () => {
  assert.equal(C.parseQuickAdd('a !!!', NOW).priority, 'high');
  assert.equal(C.parseQuickAdd('a !!', NOW).priority, 'medium');
  assert.equal(C.parseQuickAdd('a p3', NOW).priority, 'low');
  assert.equal(C.parseQuickAdd('wow!', NOW).priority, '');
  assert.deepEqual(C.parseQuickAdd('a #Home #home #side-project', NOW).tags, ['home', 'side-project']);
  assert.equal(C.parseQuickAdd('#work tomorrow', NOW).title, '');
});

test('dueInfo describes urgency', () => {
  assert.equal(C.dueInfo(plan(), NOW).state, 'none');
  assert.equal(C.dueInfo(plan({ dueDate: '2026-10-13' }), NOW).state, 'overdue');
  assert.match(C.dueInfo(plan({ dueDate: '2026-10-12' }), NOW).label, /Overdue by 2 days/);
  assert.equal(C.dueInfo(plan({ dueDate: '2026-10-14' }), NOW).state, 'today');
  assert.equal(C.dueInfo(plan({ dueDate: '2026-10-14', dueTime: '09:00' }), NOW).state, 'overdue');
  assert.equal(C.dueInfo(plan({ dueDate: '2026-10-14', dueTime: '11:00' }), NOW).state, 'today');
  assert.match(C.dueInfo(plan({ dueDate: '2026-10-15' }), NOW).label, /tomorrow/);
  assert.equal(C.dueInfo(plan({ dueDate: '2026-10-16' }), NOW).state, 'soon');
  assert.equal(C.dueInfo(plan({ dueDate: '2026-10-19' }), NOW).state, 'later');
  assert.equal(C.dueInfo(plan({ dueDate: '2026-10-01', status: 'done' }), NOW).state, 'done');
});

test('normalizePlan repairs bad input', () => {
  const p = C.normalizePlan(
    {
      title: '  ',
      status: 'weird',
      priority: 'urgent',
      dueDate: '2026-13-01',
      dueTime: '10:00',
      tags: ['#Work', 'work', 'Deep Focus', 42],
      checklist: [{ text: 'step' }, { text: '' }, null],
    },
    NOW
  );
  assert.equal(p.title, 'Untitled plan');
  assert.equal(p.status, 'todo');
  assert.equal(p.priority, 'medium');
  assert.equal(p.dueDate, '');
  assert.equal(p.dueTime, '');
  assert.deepEqual(p.tags, ['work', 'deep-focus', '42']);
  assert.equal(p.checklist.length, 1);
  assert.ok(p.id);
});

test('status changes keep timestamps honest', () => {
  const later = new Date(2026, 9, 14, 12, 0);
  const todo = plan();
  const started = C.withStatus(todo, 'in_progress', NOW);
  assert.equal(started.startedAt, NOW.toISOString());
  const done = C.withStatus(started, 'done', later);
  assert.equal(done.startedAt, NOW.toISOString());
  assert.equal(done.completedAt, later.toISOString());
  const reopened = C.withStatus(done, 'todo', later);
  assert.equal(reopened.startedAt, '');
  assert.equal(reopened.completedAt, '');
  assert.equal(C.withStatus(todo, 'todo', NOW), todo);
  assert.equal(C.nextStatus('done'), 'todo');
});

test('createPlan puts new plans at the top of their column', () => {
  const existing = [plan({ id: 'a', order: 0 }), plan({ id: 'b', order: 1 })];
  const created = C.createPlan({ title: 'New', status: 'in_progress' }, existing, NOW);
  assert.equal(created.startedAt, NOW.toISOString());
  const top = C.createPlan({ title: 'Top' }, existing, NOW);
  assert.equal(top.order, -1);
});

test('movePlan changes status and reorders the target column', () => {
  const plans = [
    plan({ id: 'a', status: 'todo', order: 0 }),
    plan({ id: 'b', status: 'todo', order: 1 }),
    plan({ id: 'c', status: 'in_progress', order: 0 }),
    plan({ id: 'd', status: 'in_progress', order: 1 }),
  ];
  const moved = C.movePlan(plans, 'a', 'in_progress', 'd', NOW);
  const column = C.sortPlans(moved.filter((p) => p.status === 'in_progress')).map((p) => p.id);
  assert.deepEqual(column, ['c', 'a', 'd']);
  assert.ok(moved.find((p) => p.id === 'a').startedAt);

  const toEnd = C.movePlan(plans, 'c', 'todo', null, NOW);
  assert.deepEqual(
    C.sortPlans(toEnd.filter((p) => p.status === 'todo')).map((p) => p.id),
    ['a', 'b', 'c']
  );
  assert.equal(C.movePlan(plans, 'missing', 'done'), plans);
});

test('filters match title, description, tags and steps', () => {
  const p = plan({ title: 'Write report', description: 'Q3 numbers', tags: ['work'], checklist: [{ text: 'charts' }] });
  assert.ok(C.matchesFilters(p, { query: 'report q3' }));
  assert.ok(C.matchesFilters(p, { query: '#work' }));
  assert.ok(C.matchesFilters(p, { query: 'charts' }));
  assert.ok(!C.matchesFilters(p, { query: 'holiday' }));
  assert.ok(C.matchesFilters(p, { tag: 'work', priority: 'medium' }));
  assert.ok(!C.matchesFilters(p, { tag: 'home' }));
  assert.ok(!C.matchesFilters(p, { priority: 'high' }));
});

test('sortPlans by deadline puts timed before all-day and undated last', () => {
  const plans = [
    plan({ id: 'none' }),
    plan({ id: 'allday', dueDate: '2026-10-15' }),
    plan({ id: 'timed', dueDate: '2026-10-15', dueTime: '08:00' }),
    plan({ id: 'early', dueDate: '2026-10-14' }),
  ];
  assert.deepEqual(C.sortPlans(plans, 'deadline').map((p) => p.id), ['early', 'timed', 'allday', 'none']);
  const prio = [plan({ id: 'l', priority: 'low' }), plan({ id: 'h', priority: 'high' })];
  assert.deepEqual(C.sortPlans(prio, 'priority').map((p) => p.id), ['h', 'l']);
});

test('groupForToday sorts open plans into one section each', () => {
  const doneNow = C.withStatus(plan({ id: 'done' }), 'done', NOW);
  const groups = C.groupForToday(
    [
      plan({ id: 'late', dueDate: '2026-10-10' }),
      plan({ id: 'today', dueDate: '2026-10-14', status: 'in_progress' }),
      plan({ id: 'doing', status: 'in_progress' }),
      plan({ id: 'soon', dueDate: '2026-10-18' }),
      plan({ id: 'far', dueDate: '2026-12-01' }),
      plan({ id: 'someday' }),
      doneNow,
    ],
    NOW
  );
  const ids = (list) => list.map((p) => p.id);
  assert.deepEqual(ids(groups.overdue), ['late']);
  assert.deepEqual(ids(groups.today), ['today']);
  assert.deepEqual(ids(groups.inProgress), ['doing']);
  assert.deepEqual(ids(groups.upcoming), ['soon']);
  assert.deepEqual(ids(groups.later), ['far', 'someday']);
  assert.deepEqual(ids(groups.doneToday), ['done']);
  assert.equal(C.nextUp([plan({ id: 'x', dueDate: '2026-10-20' }), plan({ id: 'y', dueDate: '2026-10-09' })], NOW).id, 'y');
});

test('computeStats counts progress and streaks', () => {
  const doneAt = (date) => plan({ status: 'done', completedAt: date.toISOString(), updatedAt: date.toISOString() });
  const stats = C.computeStats(
    [
      doneAt(new Date(2026, 9, 13, 18)),
      doneAt(new Date(2026, 9, 12, 9)),
      doneAt(new Date(2026, 9, 10, 9)),
      plan({ dueDate: '2026-10-14' }),
      plan({ dueDate: '2026-10-01' }),
      plan({ status: 'in_progress' }),
    ],
    NOW
  );
  assert.equal(stats.streak, 2); // yesterday and the day before; today still open
  assert.equal(stats.doneToday, 0);
  assert.equal(stats.doneThisWeek, 3);
  assert.equal(stats.overdue, 1);
  assert.equal(stats.dueToday, 1);
  assert.equal(stats.in_progress, 1);
  assert.equal(stats.todayTotal, 2);
  assert.equal(stats.todayPct, 0);
});

test('monthGrid covers six full weeks', () => {
  const monday = C.monthGrid(2026, 9, 1);
  assert.equal(monday.length, 42);
  assert.equal(C.toISODate(monday[0]), '2026-09-28');
  const sunday = C.monthGrid(2026, 9, 0);
  assert.equal(C.toISODate(sunday[0]), '2026-09-27');
});

test('import accepts exports and plain arrays, rejects junk', () => {
  const plans = [plan({ id: 'a' }), plan({ id: 'a' }), plan({ id: 'b' })];
  const json = JSON.stringify(C.exportData(plans, NOW));
  assert.deepEqual(C.importData(json, NOW).map((p) => p.id), ['a', 'b']);
  assert.equal(C.importData([{ title: 'x' }], NOW).length, 1);
  assert.throws(() => C.importData('{"nope":1}'), /does not contain/);
  assert.throws(() => C.importData('not json'));
});

test('sample plans are valid and varied', () => {
  const samples = C.samplePlans(NOW);
  assert.ok(samples.length >= 5);
  assert.deepEqual(new Set(samples.map((p) => p.status)), new Set(C.STATUSES));
  for (const p of samples) assert.deepEqual(C.normalizePlan(p, NOW), p);
});

test('changedPlanIds finds added, edited and removed plans', () => {
  const a = plan({ id: 'a' });
  const b = plan({ id: 'b' });
  const c = plan({ id: 'c' });
  const before = [a, b, c];
  const after = [a, { ...b, title: 'Edited' }, plan({ id: 'd' })];
  assert.deepEqual([...C.changedPlanIds(before, after)].sort(), ['b', 'c', 'd']);
  assert.equal(C.changedPlanIds(before, [...before]).size, 0);
});

test('applyRemoteChanges merges server changes but keeps unsent local edits', () => {
  const local = [plan({ id: 'a', title: 'Local A' }), plan({ id: 'b', title: 'Local B' }), plan({ id: 'c' })];
  const result = C.applyRemoteChanges(
    local,
    [
      { id: 'a', data: { title: 'Server A' } },
      { id: 'b', data: { title: 'Server B' } },
      { id: 'c', data: null },
      { id: 'n', data: { title: 'New from phone', status: 'done' } },
      { id: 'gone', data: null },
      { bogus: true },
    ],
    new Set(['b']),
    NOW
  );
  const byId = Object.fromEntries(result.map((p) => [p.id, p]));
  assert.equal(byId.a.title, 'Server A');
  assert.equal(byId.b.title, 'Local B'); // edited locally, not sent yet
  assert.equal(byId.c, undefined);
  assert.equal(byId.n.status, 'done');
  assert.equal(result.length, 3);

  // Identical data is not a change, so the same array comes back.
  assert.equal(C.applyRemoteChanges(result, [{ id: 'a', data: { ...byId.a } }], new Set(), NOW), result);
  assert.equal(C.applyRemoteChanges(result, [], new Set(), NOW), result);
});
