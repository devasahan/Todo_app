const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

// Wednesday, 14 October 2026, 10:00 local time.
const NOW = new Date(2026, 9, 14, 10, 0);

const plan = (fields = {}) => C.normalizePlan({ title: 'Plan', ...fields }, NOW);
const meeting = (f) => plan({ kind: 'meeting', company: 'Acme', ...f });

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
  assert.ok(top.order < 0 && top.order >= -1.5);
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

test('movePlan changes only the moved plan and marks it as changed', () => {
  const later = new Date(2026, 9, 14, 11, 0);
  const plans = [
    plan({ id: 'a', status: 'todo', order: -5 }),
    plan({ id: 'b', status: 'todo', order: -2 }),
    plan({ id: 'c', status: 'todo', order: 7 }),
    plan({ id: 'x', status: 'done', order: 0 }),
  ];
  const cases = [
    ['b', 'a', ['b', 'a', 'c']], // to the top
    ['a', 'c', ['b', 'a', 'c']], // between two
    ['a', null, ['b', 'c', 'a']], // to the end
  ];
  for (const [id, before, expected] of cases) {
    const moved = C.movePlan(plans, id, 'todo', before, later);
    assert.deepEqual(C.sortPlans(moved.filter((p) => p.status === 'todo')).map((p) => p.id), expected);
    const changed = [...C.changedPlanIds(plans, moved)];
    assert.deepEqual(changed, [id], `only ${id} changes`);
    assert.equal(moved.find((p) => p.id === id).updatedAt, later.toISOString());
  }
  // Into an empty column.
  const done = C.movePlan(plans, 'x', 'in_progress', null, later);
  assert.equal(done.find((p) => p.id === 'x').status, 'in_progress');
});

test('movePlan with no room re-spaces only the tied cards', () => {
  const plans = [
    plan({ id: 'first', order: -10 }),
    plan({ id: 'a', order: 1 }),
    plan({ id: 'b', order: 1 }), // tied with a (e.g. added on two devices at once)
    plan({ id: 'last', order: 20 }),
    plan({ id: 'm', order: 50 }),
  ];
  const moved = C.movePlan(plans, 'm', 'todo', 'b', NOW);
  assert.deepEqual(C.sortPlans(moved).map((p) => p.id), ['first', 'a', 'm', 'b', 'last']);
  const changed = [...C.changedPlanIds(plans, moved)].sort();
  assert.deepEqual(changed, ['a', 'b', 'm']); // never the whole column
});

test('equal orders always sort the same way on every device', () => {
  const x = plan({ id: 'x', order: 3 });
  const y = plan({ id: 'y', order: 3 });
  assert.deepEqual(C.sortPlans([y, x]).map((p) => p.id), ['x', 'y']);
  assert.deepEqual(C.sortPlans([x, y]).map((p) => p.id), ['x', 'y']);
});

test('many moves into the same gap keep working', () => {
  let plans = [plan({ id: 'a', order: 0 }), plan({ id: 'b', order: 1 })];
  for (let i = 0; i < 80; i += 1) {
    plans = [...plans, plan({ id: `n${i}`, order: 100 + i })];
    plans = C.movePlan(plans, `n${i}`, 'todo', 'b', NOW); // always just above b
  }
  const ids = C.sortPlans(plans).map((p) => p.id);
  assert.equal(ids[0], 'a');
  assert.equal(ids[ids.length - 1], 'b');
  assert.equal(ids[ids.length - 2], 'n79');
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

test('nextStamp is now, but always later than the version it replaces', () => {
  // An hour before NOW in any time zone.
  assert.equal(C.nextStamp(new Date(NOW.getTime() - 3600000).toISOString(), NOW), NOW.toISOString());
  // The other device's clock was ahead: still strictly newer.
  const ahead = new Date(NOW.getTime() + 10 * 60 * 1000).toISOString();
  assert.ok(C.nextStamp(ahead, NOW) > ahead);
  assert.equal(C.nextStamp('', NOW), NOW.toISOString());
  assert.equal(C.nextStamp('garbage', NOW), NOW.toISOString());
  // Status changes and moves use it too.
  const p = plan({ updatedAt: ahead });
  assert.ok(C.withStatus(p, 'done', NOW).updatedAt > ahead);
  assert.ok(C.movePlan([p], p.id, 'todo', null, NOW)[0].updatedAt > ahead);
});

/* -------------------------------------------------------------- meetings */

test('normalizePlan adds meeting fields and keeps them only on meetings', () => {
  const p = plan();
  assert.equal(p.kind, 'plan');
  assert.equal(p.company, '');
  assert.equal(p.meetingUrl, '');
  assert.equal(p.jobUrl, '');
  assert.ok('kind' in p);
  // Placed right after priority.
  const keys = Object.keys(p);
  assert.deepEqual(keys.slice(keys.indexOf('priority') + 1, keys.indexOf('priority') + 5), [
    'kind',
    'company',
    'meetingUrl',
    'jobUrl',
  ]);

  const other = plan({ kind: 'webinar', company: 'X', meetingUrl: 'https://a.com' });
  assert.equal(other.kind, 'plan');
  assert.equal(other.company, '');
  assert.equal(other.meetingUrl, '');

  const named = meeting({ title: '', company: '  Acme \n Inc. ' });
  assert.equal(named.company, 'Acme Inc.');
  assert.equal(named.title, 'Interview with Acme Inc.');
  assert.equal(meeting({ title: '', company: '' }).title, 'Untitled meeting');
  assert.equal(meeting({ company: 'x'.repeat(300) }).company.length, 120);
  assert.equal(meeting({ meetingUrl: 'zoom.us/j/1' }).meetingUrl, 'https://zoom.us/j/1');

  const full = meeting({
    title: '',
    company: ' Acme   Inc. ',
    dueDate: '2026-10-20',
    dueTime: '14:30',
    meetingUrl: 'HTTPS://Zoom.US/j/1?pwd=x',
    jobUrl: 'bücher.example/jobs/1',
    description: 'Notes',
    tags: ['job-search'],
    checklist: [{ text: 'Research' }],
  });
  assert.deepEqual(C.normalizePlan(full, NOW), full);
  assert.equal(JSON.stringify(C.normalizePlan(full, NOW)), JSON.stringify(full));

  assert.equal(C.fromOlderVersion(plan()), false);
  assert.equal(C.fromOlderVersion({ title: 'x' }), true);
  assert.equal(C.fromOlderVersion(null), false);
});

test('cleanUrl only ever returns http and https links', () => {
  const rejected = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    '\u0001javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.com/1',
    'mailto:me@example.com',
    'tel:+15551234567',
    'ftp://example.com/file',
    'https://',
    'not a link',
    'zoom',
    'acme',
    'https://x.com/a b',
    `https://example.com/${'a'.repeat(2000)}`,
    `https://example.com/${'"'.repeat(700)}`, // too long only once the quotes are escaped
    'https://example.com/\u0085',
    'localhost:3000',
    'http://localhost:8080/x',
    'https://user:pw@evil.com',
    'https://zoom.us@evil.com/',
    'https://exa"mple.com/x',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
  ];
  for (const value of rejected) assert.equal(C.cleanUrl(value), '', JSON.stringify(String(value)));

  const accepted = {
    'zoom.us/j/123': 'https://zoom.us/j/123',
    'HTTPS://Zoom.US/j/1?pwd=x': 'https://zoom.us/j/1?pwd=x',
    '//evil.com/x': 'https://evil.com/x',
    '  https://meet.google.com/abc-defg-hij  ': 'https://meet.google.com/abc-defg-hij',
    'http://example.com': 'http://example.com/',
    'https://bücher.example/jobs': 'https://xn--bcher-kva.example/jobs',
    'https://example.com/a"b?c="d"#"e"': 'https://example.com/a%22b?c=%22d%22#%22e%22',
  };
  for (const [input, expected] of Object.entries(accepted)) assert.equal(C.cleanUrl(input), expected, input);

  for (const value of [...rejected, ...Object.keys(accepted)]) {
    const out = C.cleanUrl(value);
    if (!out) continue;
    assert.equal(C.cleanUrl(out), out);
    assert.match(out, /^https?:\/\//);
    assert.ok(!out.includes('"'), out);
  }
});

test('extractUrl and linkHost', () => {
  assert.equal(
    C.extractUrl('Join Zoom Meeting https://us02web.zoom.us/j/8?pwd=xY. Meeting ID: 8'),
    'https://us02web.zoom.us/j/8?pwd=xY'
  );
  assert.equal(C.extractUrl('https://zoom.us/j/1'), 'https://zoom.us/j/1');
  assert.equal(C.extractUrl('  zoom.us/j/1 '), 'zoom.us/j/1');
  assert.equal(C.extractUrl('(see https://example.com/jobs/1)'), 'https://example.com/jobs/1');
  assert.equal(C.extractUrl('no link here'), 'no link here');
  assert.equal(C.extractUrl(null), '');
  assert.equal(C.linkHost('https://www.linkedin.com/jobs/1'), 'linkedin.com');
  assert.equal(C.linkHost('javascript:alert(1)'), '');
});

test('importing a backup never brings in unsafe links', () => {
  const [m] = C.importData(
    [
      {
        id: 'm',
        kind: 'meeting',
        title: 'Call',
        company: '<img src=x onerror=alert(1)>',
        meetingUrl: 'javascript:alert(1)',
        jobUrl: 'data:text/html,x',
      },
    ],
    NOW
  );
  assert.equal(m.meetingUrl, '');
  assert.equal(m.jobUrl, '');
  assert.equal(m.kind, 'meeting');
  assert.equal(m.title, 'Call');
  assert.equal(m.company, '<img src=x onerror=alert(1)>'); // plain text; the UI escapes it
});

test('dueInfo describes meetings without calling them overdue', () => {
  const info = (dueDate, dueTime, f = {}, now = NOW) => C.dueInfo(meeting({ dueDate, dueTime, ...f }), now);

  const soon = info('2026-10-14', '10:30');
  assert.equal(soon.state, 'now');
  assert.match(soon.label, /Starts in 30 minutes/);
  assert.equal(soon.minutes, 30);
  assert.match(info('2026-10-14', '10:01').label, /^Starts in 1 minute$/);
  assert.equal(info('2026-10-14', '11:00').state, 'now');
  assert.equal(info('2026-10-14', '11:01').state, 'today');

  const starting = info('2026-10-14', '10:00');
  assert.equal(starting.state, 'now');
  assert.match(starting.label, /Starting now/);
  const happening = info('2026-10-14', '09:30');
  assert.equal(happening.state, 'now');
  assert.match(happening.label, /Happening now/);

  const later = info('2026-10-14', '11:30');
  assert.equal(later.state, 'today');
  assert.equal(later.label, `Today at ${C.formatTime('11:30')}`);

  const morning = info('2026-10-14', '09:00');
  assert.equal(morning.state, 'past');
  assert.match(morning.label, /Earlier today/);

  const yesterday = info('2026-10-13', '15:00');
  assert.equal(yesterday.state, 'past');
  assert.match(yesterday.label, /Yesterday/);
  assert.equal(yesterday.days, -1);
  assert.equal(info('2026-10-01', '').state, 'past');

  const tomorrow = info('2026-10-15', '09:00');
  assert.equal(tomorrow.state, 'soon');
  assert.match(tomorrow.label, /Tomorrow at/);

  const far = info('2026-10-30', '09:00');
  assert.equal(far.state, 'later');
  assert.equal(far.label, `${C.formatDate(C.parseISODate('2026-10-30'), NOW)} at ${C.formatTime('09:00')}`);

  const allDay = info('2026-10-14', '');
  assert.equal(allDay.state, 'today');
  assert.equal(allDay.minutes, null);

  const undated = info('', '');
  assert.equal(undated.state, 'none');
  assert.equal(undated.label, 'Date not set');

  assert.equal(info('2026-10-14', '10:30', { status: 'done' }).state, 'done');
  assert.equal(info('2026-10-14', '23:30', {}, new Date(2026, 9, 15, 0, 10)).state, 'now');

  // Plans are unchanged.
  assert.equal(C.dueInfo(plan({ dueDate: '2026-10-14', dueTime: '09:00' }), NOW).state, 'overdue');
});

test('groupForToday keeps meetings out of Overdue', () => {
  const doneNow = C.withStatus(meeting({ id: 'done', dueDate: '2026-10-14', dueTime: '08:00' }), 'done', NOW);
  const groups = C.groupForToday(
    [
      meeting({ id: 'old', dueDate: '2026-10-01', dueTime: '09:00' }),
      meeting({ id: 'yesterday', dueDate: '2026-10-13', dueTime: '15:00' }),
      meeting({ id: 'morning', dueDate: '2026-10-14', dueTime: '09:00' }),
      meeting({ id: 'soon', dueDate: '2026-10-14', dueTime: '10:30' }),
      meeting({ id: 'monday', dueDate: '2026-10-19', dueTime: '09:00' }),
      plan({ id: 'late', dueDate: '2026-10-10' }),
      doneNow,
    ],
    NOW
  );
  const ids = (list) => list.map((p) => p.id);
  assert.deepEqual(Object.keys(groups), [
    'overdue',
    'today',
    'inProgress',
    'upcoming',
    'pastMeetings',
    'doneToday',
    'later',
  ]);
  assert.deepEqual(ids(groups.pastMeetings), ['yesterday', 'old']); // newest first
  assert.deepEqual(ids(groups.today), ['morning', 'soon']);
  assert.deepEqual(ids(groups.upcoming), ['monday']);
  assert.deepEqual(ids(groups.overdue), ['late']);
  assert.deepEqual(ids(groups.doneToday), ['done']);
  assert.ok(!groups.overdue.some(C.isMeeting));
});

test('nextUp prefers a meeting that is about to start', () => {
  const late = plan({ id: 'late', dueDate: '2026-10-10' });
  const at = (id, dueDate, dueTime) => meeting({ id, dueDate, dueTime });
  assert.equal(C.nextUp([late, at('call', '2026-10-14', '10:20')], NOW).id, 'call');
  assert.equal(C.nextUp([late, at('call', '2026-10-14', '10:40'), at('first', '2026-10-14', '10:20')], NOW).id, 'first');
  assert.equal(C.nextUp([late, at('call', '2026-10-14', '09:00')], NOW).id, 'late');
  const task = plan({ id: 'task', dueDate: '2026-10-14', dueTime: '11:00' });
  assert.equal(C.nextUp([at('call', '2026-10-14', '08:00'), task], NOW).id, 'task');
  assert.equal(C.nextUp([at('call', '2026-10-15', '09:00')], NOW).id, 'call');
  // Back-to-back interviews: the next one about to start, not the one still running.
  assert.equal(C.nextUp([at('first', '2026-10-14', '09:15'), at('second', '2026-10-14', '10:05')], NOW).id, 'second');
  assert.equal(C.nextUp([at('first', '2026-10-14', '09:50'), at('second', '2026-10-14', '10:40')], NOW).id, 'first');
});

test('computeStats ignores past meetings', () => {
  const stats = C.computeStats(
    [
      meeting({ dueDate: '2026-10-13', dueTime: '15:00' }),
      meeting({ dueDate: '2026-10-14', dueTime: '15:00' }),
      plan({ dueDate: '2026-10-14' }),
    ],
    NOW
  );
  assert.equal(stats.overdue, 0);
  assert.equal(stats.dueToday, 2);
  assert.equal(stats.todayTotal, 2);
});

test('filters find meetings by company and type', () => {
  const m = meeting({ title: 'Phone screen' });
  const p = plan({ title: 'Write report' });
  assert.ok(C.matchesFilters(m, { query: 'acme' }));
  assert.ok(C.matchesFilters(m, { kind: 'meeting' }));
  assert.ok(!C.matchesFilters(p, { kind: 'meeting' }));
  assert.ok(C.matchesFilters(p, { kind: 'plan' }));
  assert.ok(!C.matchesFilters(m, { kind: 'plan' }));
});

test('nextStatus toggles meetings between to do and done', () => {
  assert.equal(C.nextStatus('todo', 'meeting'), 'done');
  assert.equal(C.nextStatus('in_progress', 'meeting'), 'done');
  assert.equal(C.nextStatus('done', 'meeting'), 'todo');
  assert.equal(C.nextStatus('todo'), 'in_progress');
  assert.equal(C.nextStatus('todo', 'plan'), 'in_progress');
});

test('applyRemoteChanges keeps meeting details an older version left out', () => {
  const local = [
    meeting({ id: 'm', meetingUrl: 'https://zoom.us/j/1', jobUrl: 'https://example.com/jobs/1' }),
    plan({ id: 'p' }),
  ];
  const later = new Date(2026, 9, 14, 11, 0).toISOString();
  const stripped = { title: 'Renamed', dueDate: '2026-10-20', dueTime: '14:00', updatedAt: later };

  const result = C.applyRemoteChanges(local, [{ id: 'm', data: stripped }], new Set(), NOW);
  const m = result.find((p) => p.id === 'm');
  assert.equal(m.title, 'Renamed');
  assert.equal(m.kind, 'meeting');
  assert.equal(m.company, 'Acme');
  assert.equal(m.meetingUrl, 'https://zoom.us/j/1');
  assert.equal(m.jobUrl, 'https://example.com/jobs/1');
  assert.equal(m.dueTime, '14:00');

  // A copy that says it is a plan converts it.
  const converted = C.applyRemoteChanges(local, [{ id: 'm', data: { ...stripped, kind: 'plan' } }], new Set(), NOW);
  assert.equal(converted.find((p) => p.id === 'm').kind, 'plan');
  assert.equal(converted.find((p) => p.id === 'm').company, '');

  // Nothing to keep for an unknown id, or for a plan.
  const added = C.applyRemoteChanges(local, [{ id: 'x', data: { title: 'From an old tab' } }], new Set(), NOW);
  assert.equal(added.find((p) => p.id === 'x').kind, 'plan');
  const edited = C.applyRemoteChanges(local, [{ id: 'p', data: { title: 'Edited' } }], new Set(), NOW);
  assert.equal(edited.find((p) => p.id === 'p').kind, 'plan');

  // Getting the stripped copy of the result again is not a change.
  const again = { ...m };
  for (const key of ['kind', 'company', 'meetingUrl', 'jobUrl']) delete again[key];
  assert.equal(C.applyRemoteChanges(result, [{ id: 'm', data: again }], new Set(), NOW), result);
});

test('importData keeps meeting details an older backup lacks', () => {
  const localMeeting = meeting({ id: 'm', meetingUrl: 'https://zoom.us/j/1', jobUrl: 'https://example.com/jobs/1' });
  const [kept] = C.importData([{ id: 'm', title: 'Renamed' }], NOW, [localMeeting]);
  assert.equal(kept.title, 'Renamed');
  assert.equal(kept.kind, 'meeting');
  assert.equal(kept.company, 'Acme');
  assert.equal(kept.meetingUrl, 'https://zoom.us/j/1');
  assert.equal(kept.jobUrl, 'https://example.com/jobs/1');

  const [plain] = C.importData([{ id: 'm', title: 'Renamed' }], NOW);
  assert.equal(plain.kind, 'plan');
  assert.equal(plain.company, '');

  const [converted] = C.importData([{ id: 'm', title: 'Renamed', kind: 'plan' }], NOW, [localMeeting]);
  assert.equal(converted.kind, 'plan');
  assert.equal(converted.meetingUrl, '');
});

test('meetingTitle and formatShortTime', () => {
  assert.equal(C.meetingTitle(''), '');
  assert.equal(C.meetingTitle('Acme'), 'Interview with Acme');
  const twelveHour = ['h11', 'h12'].includes(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle);
  if (twelveHour) assert.doesNotMatch(C.formatShortTime('14:00'), /:00/);
  // A 24-hour clock keeps the minutes: a bare "14" would look like a date.
  else assert.equal(C.formatShortTime('14:00'), C.formatTime('14:00'));
  assert.match(C.formatShortTime('14:30'), /30/);
});

test('meetingICS builds a valid calendar file', () => {
  const utc = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const m = meeting({
    id: 'abc',
    title: 'Interview with Acme, Inc.',
    company: 'Acme, Inc.',
    dueDate: '2026-10-20',
    dueTime: '14:30',
    meetingUrl: 'https://zoom.us/j/1',
    description: 'Ask; bring CV\nSecond line',
  });
  const out = C.meetingICS(m, NOW);
  assert.ok(out.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(out.endsWith('END:VCALENDAR\r\n'));
  assert.doesNotMatch(out, /(^|[^\r])\n/); // every LF is preceded by CR

  const unfolded = out.replace(/\r\n /g, '');
  const lines = unfolded.split('\r\n');
  assert.deepEqual(lines.slice(0, 6), [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dayplan//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
  ]);
  assert.deepEqual(lines.slice(-3), ['END:VEVENT', 'END:VCALENDAR', '']);
  assert.ok(lines.includes(`DTSTAMP:${utc(NOW)}`));
  assert.ok(lines.includes(`DTSTART:${utc(new Date(2026, 9, 20, 14, 30))}`));
  assert.ok(lines.includes(`DTEND:${utc(new Date(2026, 9, 20, 15, 30))}`));
  assert.ok(lines.includes('UID:abc@dayplan'));
  assert.ok(lines.includes('URL:https://zoom.us/j/1'));
  assert.ok(lines.includes('LOCATION:https://zoom.us/j/1'));
  assert.ok(lines.includes('ACTION:DISPLAY'));
  assert.ok(lines.includes('TRIGGER:-PT15M'));
  assert.ok(lines.includes('SUMMARY:Interview with Acme\\, Inc.'));
  assert.ok(lines.includes('DESCRIPTION:Interview with Acme\\, Inc.')); // inside the alarm
  assert.ok(
    lines.includes('DESCRIPTION:Company: Acme\\, Inc.\\nMeeting link: https://zoom.us/j/1\\n\\nAsk\\; bring CV\\nSecond line')
  );
  assert.ok(unfolded.includes('Ask\\; bring CV\\nSecond line')); // the notes

  const bytesOk = (text) => text.split('\r\n').every((line) => Buffer.byteLength(line) <= 75);
  assert.ok(bytesOk(out));
  const title = 'é😀'.repeat(40);
  const long = C.meetingICS({ ...m, title }, NOW);
  assert.ok(bytesOk(long));
  assert.ok(long.replace(/\r\n /g, '').split('\r\n').includes(`SUMMARY:${title}`));
  // No emoji is cut in half at a fold (that would survive a JS round trip but not UTF-8).
  assert.ok(long.split('\r\n').every((line) => Buffer.from(line, 'utf8').toString('utf8') === line));
  // Times are converted from the device's time zone to UTC, even where the tests run in UTC.
  const zone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const ny = C.meetingICS(m, NOW).replace(/\r\n /g, '').split('\r\n');
    assert.ok(ny.includes('DTSTART:20261020T183000Z'));
    assert.ok(ny.includes('DTEND:20261020T193000Z'));
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }

  // Control characters can't break a line or add one.
  const odd = C.meetingICS({ ...m, id: 'x\r\nATTENDEE:evil', title: 'a\u0007b\\c' }, NOW).split('\r\n');
  assert.ok(odd.includes('UID:x\\nATTENDEE:evil@dayplan'));
  assert.ok(odd.includes('SUMMARY:ab\\\\c'));

  const allDay = C.meetingICS({ ...m, dueTime: '' }, NOW);
  assert.ok(allDay.includes('DTSTART;VALUE=DATE:20261020'));
  assert.ok(allDay.includes('DTEND;VALUE=DATE:20261021'));
  assert.ok(!allDay.includes('VALARM'));
  assert.ok(C.meetingICS({ ...m, dueDate: '2026-12-31', dueTime: '' }, NOW).includes('DTEND;VALUE=DATE:20270101'));

  assert.equal(C.meetingICS({ ...m, dueDate: '' }, NOW), '');
  assert.equal(C.meetingICS(plan({ dueDate: '2026-10-20', dueTime: '14:30' }), NOW), '');

  assert.equal(C.icsFileName(m), 'interview-with-acme-inc-2026-10-20.ics');
  assert.equal(C.icsFileName(meeting({ title: '!!!' })), 'meeting.ics');
});

test('sample plans include a meeting with example links', () => {
  const samples = C.samplePlans(NOW);
  const m = samples.find((p) => p.kind === 'meeting');
  assert.ok(m);
  assert.ok(m.meetingUrl.startsWith('https://example.com/'));
  assert.ok(m.jobUrl.startsWith('https://example.com/'));
});
