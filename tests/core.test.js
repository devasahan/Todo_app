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

/* ------------------------------------- time zones, end times, documents */

// Runs `fn` as if the device were in `zone`. Node reads TZ again whenever it
// changes, so local Dates and Intl both follow.
function inZone(zone, fn) {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

const PDF = { id: 'a'.repeat(32), name: 'Resume.pdf', size: 48213 };
const LETTER = { id: '0123456789abcdef0123456789abcdef', name: 'Cover letter.pdf', size: 1200 };
const SUMMER = new Date(Date.UTC(2026, 6, 1, 12));
const WINTER = new Date(Date.UTC(2026, 0, 15, 12));

test('normalizePlan adds time zone, end time and documents, kept only on meetings', () => {
  const p = plan();
  assert.equal(p.timeZone, '');
  assert.equal(p.endTime, '');
  assert.equal(p.resume, null);
  assert.equal(p.coverLetter, null);
  // Always written, right after the other meeting fields.
  const keys = Object.keys(p);
  const after = keys.indexOf('jobUrl') + 1;
  assert.deepEqual(keys.slice(after, after + 4), ['timeZone', 'endTime', 'resume', 'coverLetter']);

  const asPlan = plan({
    dueDate: '2026-10-20',
    dueTime: '14:00',
    endTime: '15:00',
    timeZone: 'America/New_York',
    resume: PDF,
    coverLetter: LETTER,
  });
  assert.deepEqual([asPlan.timeZone, asPlan.endTime, asPlan.resume, asPlan.coverLetter], ['', '', null, null]);

  for (const tz of ['America/New_York', 'Asia/Kolkata', 'UTC', 'Pacific/Chatham', 'Australia/Lord_Howe']) {
    assert.equal(meeting({ timeZone: tz }).timeZone, tz);
  }
  for (const tz of ['Nowhere/Special', ' America/New_York', '', 42, null, {}, ['UTC'], `America/${'x'.repeat(200)}`]) {
    assert.equal(meeting({ timeZone: tz }).timeZone, '', JSON.stringify(tz));
  }

  const at = (f) => meeting({ dueDate: '2026-10-20', dueTime: '14:00', ...f });
  assert.equal(at({ endTime: '15:30' }).endTime, '15:30');
  assert.equal(at({ endTime: '14:01' }).endTime, '14:01');
  assert.equal(at({ endTime: '23:59' }).endTime, '23:59');
  // Never at or before the start (no overnight meetings), and only a real time.
  for (const endTime of ['14:00', '13:59', '00:30', '24:00', '3pm', '15:3', '', null, 1530]) {
    assert.equal(at({ endTime }).endTime, '', JSON.stringify(endTime));
  }
  assert.equal(at({ dueTime: '', endTime: '15:00' }).endTime, ''); // needs a start time
  assert.equal(meeting({ dueTime: '14:00', endTime: '15:00' }).endTime, ''); // and a date
});

test('normalizePlan keeps only well-formed documents', () => {
  assert.deepEqual(meeting({ resume: PDF }).resume, PDF);
  assert.deepEqual(meeting({ coverLetter: LETTER }).coverLetter, LETTER);
  assert.deepEqual(meeting({ resume: { ...PDF, url: 'javascript:x', extra: 1 } }).resume, PDF);
  assert.deepEqual(meeting({ resume: { ...PDF, size: 0 } }).resume, { ...PDF, size: 0 });

  const named = (name) => meeting({ resume: { ...PDF, name } }).resume.name;
  assert.equal(named('  My\u0000 CV\r\n.pdf\u0085  '), 'My CV.pdf');
  for (const name of ['', '   ', '\u0007\u0008', 42, null, undefined, {}]) {
    assert.equal(named(name), 'document.pdf', JSON.stringify(name));
  }
  assert.equal(named('a'.repeat(300)).length, 120);
  assert.equal(named(`${'a'.repeat(119)} tail`), 'a'.repeat(119)); // trimmed after cutting
  // Cut by characters, so an emoji is never split in half.
  const emoji = named('😀'.repeat(130));
  assert.equal([...emoji].length, 120);
  assert.equal(emoji, '😀'.repeat(120));

  const bad = [
    null,
    'Resume.pdf',
    PDF.id,
    [PDF],
    42,
    { ...PDF, id: 'A'.repeat(32) },
    { ...PDF, id: 'a'.repeat(31) },
    { ...PDF, id: 'a'.repeat(33) },
    { ...PDF, id: 'g'.repeat(32) },
    { ...PDF, id: `../${'a'.repeat(29)}` },
    { ...PDF, id: 123 },
    { ...PDF, size: -1 },
    { ...PDF, size: 1.5 },
    { ...PDF, size: '10' },
    { ...PDF, size: NaN },
    { ...PDF, size: Infinity },
    { name: 'x.pdf', size: 1 },
  ];
  for (const value of bad) {
    assert.equal(meeting({ resume: value }).resume, null, JSON.stringify(value));
    assert.equal(C.normalizeFile(value), null);
  }

  assert.deepEqual(C.normalizeFile({ ...PDF, name: ' x.pdf ' }), { ...PDF, name: 'x.pdf' });
});

test('normalizePlan stays idempotent with the new fields', () => {
  const full = meeting({
    title: '',
    company: 'Acme',
    dueDate: '2026-10-20',
    dueTime: '14:30',
    endTime: '15:15',
    timeZone: 'America/New_York',
    resume: { ...PDF, name: `  ${'é'.repeat(118)} \u0001xyz  ` },
    coverLetter: { ...LETTER, name: '\tCover letter.pdf ' },
  });
  assert.deepEqual(C.normalizePlan(full, NOW), full);
  assert.equal(JSON.stringify(C.normalizePlan(full, NOW)), JSON.stringify(full));
  assert.equal(JSON.stringify(C.normalizePlan(JSON.parse(JSON.stringify(full)), NOW)), JSON.stringify(full));
});

test('meetings saved before time zones keep working exactly as before', () => {
  const stored = {
    id: 'old',
    kind: 'meeting',
    title: 'Call',
    company: 'Acme',
    dueDate: '2026-10-20',
    dueTime: '14:30',
    status: 'todo',
    priority: 'medium',
    meetingUrl: '',
    jobUrl: '',
    tags: [],
    checklist: [],
    order: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
  const m = C.normalizePlan(stored, NOW);
  assert.deepEqual([m.timeZone, m.endTime, m.resume, m.coverLetter], ['', '', null, null]);
  for (const zone of ['UTC', 'Asia/Tokyo', 'America/New_York']) {
    inZone(zone, () => {
      // Device time, as before.
      assert.equal(C.meetingStart(m).getTime(), new Date(2026, 9, 20, 14, 30).getTime(), zone);
      assert.equal(C.meetingEnd(m), null);
      assert.equal(C.meetingEndOrDefault(m).getTime(), new Date(2026, 9, 20, 15, 30).getTime(), zone);
      assert.deepEqual(C.localDue(m), { date: '2026-10-20', time: '14:30' });
      assert.equal(C.zoneDiffers(m), false);
      assert.equal(C.formatTimeRange(m), C.formatTime('14:30'));
      const now = new Date(2026, 9, 14, 10, 0);
      const due = C.dueInfo(m, now);
      assert.equal(due.label, `Tuesday at ${C.formatTime('14:30')}`);
      assert.equal(due.full, `${C.formatDate(new Date(2026, 9, 20), now)} at ${C.formatTime('14:30')}`);
    });
  }
});

test('isValidTimeZone and localTimeZone', () => {
  for (const tz of ['America/New_York', 'Asia/Kolkata', 'UTC', 'Europe/Berlin', 'Pacific/Chatham']) {
    assert.ok(C.isValidTimeZone(tz), tz);
  }
  for (const tz of ['', 'Nowhere/Special', 'New York', null, undefined, 42, {}, `Europe/${'x'.repeat(200)}`]) {
    assert.ok(!C.isValidTimeZone(tz), JSON.stringify(tz));
  }
  // '' when the device can't tell (Node says "Etc/Unknown" for an empty TZ).
  const local = C.localTimeZone();
  assert.ok(local === '' || C.isValidTimeZone(local), local);
  inZone('Asia/Tokyo', () => assert.equal(C.localTimeZone(), 'Asia/Tokyo'));
  inZone('America/New_York', () => assert.equal(C.localTimeZone(), 'America/New_York'));
});

test('zonedInstant finds the moment a wall clock shows, in any time zone', () => {
  const at = (date, time, zone) => C.zonedInstant(date, time, zone).toISOString();

  assert.equal(at('2026-10-20', '14:30', 'America/New_York'), '2026-10-20T18:30:00.000Z'); // EDT
  assert.equal(at('2026-01-15', '09:00', 'America/New_York'), '2026-01-15T14:00:00.000Z'); // EST
  assert.equal(at('2026-10-20', '09:00', 'Asia/Kolkata'), '2026-10-20T03:30:00.000Z'); // +05:30
  assert.equal(at('2026-10-20', '00:15', 'Asia/Kolkata'), '2026-10-19T18:45:00.000Z'); // the day before in UTC
  assert.equal(at('2026-10-20', '00:00', 'UTC'), '2026-10-20T00:00:00.000Z');
  assert.equal(at('2026-06-15', '12:00', 'Pacific/Chatham'), '2026-06-14T23:15:00.000Z'); // +12:45
  assert.equal(at('2026-12-15', '12:00', 'Pacific/Chatham'), '2026-12-14T22:15:00.000Z'); // +13:45
  assert.equal(at('2026-06-15', '12:00', 'Australia/Lord_Howe'), '2026-06-15T01:30:00.000Z'); // +10:30
  assert.equal(at('2026-12-15', '12:00', 'Australia/Lord_Howe'), '2026-12-15T01:00:00.000Z'); // +11, half-hour DST

  // The night the clocks go forward, a skipped time moves on by the jump.
  assert.equal(at('2026-03-08', '01:59', 'America/New_York'), '2026-03-08T06:59:00.000Z');
  assert.equal(at('2026-03-08', '02:00', 'America/New_York'), '2026-03-08T07:00:00.000Z');
  assert.equal(at('2026-03-08', '02:30', 'America/New_York'), '2026-03-08T07:30:00.000Z'); // 3:30 EDT
  assert.equal(at('2026-03-08', '03:00', 'America/New_York'), '2026-03-08T07:00:00.000Z');
  assert.equal(at('2026-10-04', '02:15', 'Australia/Lord_Howe'), '2026-10-03T15:45:00.000Z'); // 2:45, +11
  assert.equal(at('2026-09-27', '03:00', 'Pacific/Chatham'), '2026-09-26T14:15:00.000Z'); // 4:00, +13:45

  // The night they go back, a time that happens twice is the first one.
  assert.equal(at('2026-11-01', '00:59', 'America/New_York'), '2026-11-01T04:59:00.000Z');
  assert.equal(at('2026-11-01', '01:30', 'America/New_York'), '2026-11-01T05:30:00.000Z'); // EDT, not EST
  assert.equal(at('2026-11-01', '02:00', 'America/New_York'), '2026-11-01T07:00:00.000Z');
  assert.equal(at('2026-04-05', '01:45', 'Australia/Lord_Howe'), '2026-04-04T14:45:00.000Z'); // +11, not +10:30
  assert.equal(at('2026-04-05', '03:00', 'Pacific/Chatham'), '2026-04-04T13:15:00.000Z'); // +13:45, not +12:45

  // No time zone, or one the browser doesn't know: the device's own time.
  const local = new Date(2026, 9, 20, 14, 30).getTime();
  assert.equal(C.zonedInstant('2026-10-20', '14:30', '').getTime(), local);
  assert.equal(C.zonedInstant('2026-10-20', '14:30').getTime(), local);
  assert.equal(C.zonedInstant('2026-10-20', '14:30', 'Nowhere/Special').getTime(), local);

  assert.equal(C.zonedInstant('2026-02-31', '14:30', 'UTC'), null);
  assert.equal(C.zonedInstant('2026-10-20', '25:00', 'UTC'), null);
  assert.equal(C.zonedInstant('', '', 'UTC'), null);

  // Every call returns its own Date, even from the cache.
  const first = C.zonedInstant('2026-10-20', '14:30', 'America/New_York');
  first.setFullYear(2000);
  assert.equal(at('2026-10-20', '14:30', 'America/New_York'), '2026-10-20T18:30:00.000Z');
});

test('zonedInstant agrees with a device in that time zone, around every change of the clocks', () => {
  const days = {
    'America/New_York': ['2026-03-08', '2026-11-01'],
    'Europe/Berlin': ['2026-03-29', '2026-10-25'],
    'Asia/Kolkata': ['2026-10-20'],
    'Pacific/Chatham': ['2026-04-05', '2026-09-27'],
    'Australia/Lord_Howe': ['2026-04-05', '2026-10-04'],
  };
  const pad = (n) => String(n).padStart(2, '0');
  for (const [zone, dates] of Object.entries(days)) {
    inZone(zone, () => {
      for (const date of dates) {
        const [y, mo, d] = date.split('-').map(Number);
        for (let m = 0; m < 24 * 60; m += 15) {
          const h = Math.floor(m / 60);
          const time = `${pad(h)}:${pad(m % 60)}`;
          const expected = new Date(y, mo - 1, d, h, m % 60).getTime();
          assert.equal(C.zonedInstant(date, time, zone).getTime(), expected, `${zone} ${date} ${time}`);
        }
      }
    });
  }
});

test('meetingStart, meetingEnd and localDue follow the meeting time zone', () => {
  const ny = meeting({ dueDate: '2026-10-20', dueTime: '14:00', endTime: '15:30', timeZone: 'America/New_York' });
  assert.equal(C.meetingStart(ny).toISOString(), '2026-10-20T18:00:00.000Z');
  assert.equal(C.meetingEnd(ny).toISOString(), '2026-10-20T19:30:00.000Z');
  assert.equal(C.meetingEndOrDefault(ny).toISOString(), '2026-10-20T19:30:00.000Z');

  const noEnd = { ...ny, endTime: '' };
  assert.equal(C.meetingEnd(noEnd), null);
  assert.equal(C.meetingEndOrDefault(noEnd).toISOString(), '2026-10-20T19:00:00.000Z'); // an hour
  assert.equal(C.meetingEnd({ ...ny, endTime: '13:00' }), null); // even when not normalized
  assert.equal(C.meetingStart({ ...ny, dueTime: '' }), null);
  assert.equal(C.meetingEnd({ ...ny, dueTime: '' }), null);
  assert.equal(C.meetingEndOrDefault({ ...ny, dueTime: '' }), null);
  assert.equal(C.meetingStart(meeting()), null);
  assert.equal(C.meetingStart(null), null);

  // 1:30 to 3:30 the night the clocks go forward is one hour.
  const short = meeting({ dueDate: '2026-03-08', dueTime: '01:30', endTime: '03:30', timeZone: 'America/New_York' });
  assert.equal(C.meetingEnd(short) - C.meetingStart(short), 60 * 60 * 1000);

  inZone('Asia/Tokyo', () => assert.deepEqual(C.localDue(ny), { date: '2026-10-21', time: '03:00' }));
  inZone('America/Los_Angeles', () => assert.deepEqual(C.localDue(ny), { date: '2026-10-20', time: '11:00' }));
  inZone('America/New_York', () => assert.deepEqual(C.localDue(ny), { date: '2026-10-20', time: '14:00' }));
  inZone('Asia/Kolkata', () => assert.deepEqual(C.localDue(ny), { date: '2026-10-20', time: '23:30' }));

  // Without a zone or a time, or for a plan: as saved.
  inZone('Asia/Tokyo', () => {
    assert.deepEqual(C.localDue({ ...ny, timeZone: '' }), { date: '2026-10-20', time: '14:00' });
    assert.deepEqual(C.localDue({ ...ny, dueTime: '' }), { date: '2026-10-20', time: '' });
    const p = plan({ dueDate: '2026-10-20', dueTime: '14:00' });
    assert.deepEqual(C.localDue(p), { date: '2026-10-20', time: '14:00' });
    assert.deepEqual(C.localDue({ ...p, timeZone: 'America/New_York' }), { date: '2026-10-20', time: '14:00' });
    assert.deepEqual(C.localDue(plan()), { date: '', time: '' });
  });
});

test('zoneDiffers compares the clocks, not the names', () => {
  const ny = meeting({ dueDate: '2026-10-20', dueTime: '14:00', timeZone: 'America/New_York' });
  inZone('America/New_York', () => assert.equal(C.zoneDiffers(ny), false));
  inZone('America/Detroit', () => assert.equal(C.zoneDiffers(ny), false)); // another name, same clocks
  inZone('Europe/Berlin', () => assert.equal(C.zoneDiffers(ny), true));
  inZone('Asia/Kolkata', () => assert.equal(C.zoneDiffers(ny), true));
  assert.equal(C.zoneDiffers({ ...ny, timeZone: '' }), false);
  assert.equal(C.zoneDiffers({ ...ny, dueTime: '' }), false);
  assert.equal(C.zoneDiffers(plan({ dueDate: '2026-10-20', dueTime: '14:00' })), false);

  // London and UTC agree in winter, but not in summer.
  const london = (dueDate) => meeting({ dueDate, dueTime: '10:00', timeZone: 'Europe/London' });
  inZone('UTC', () => {
    assert.equal(C.zoneDiffers(london('2026-01-15')), false);
    assert.equal(C.zoneDiffers(london('2026-07-15')), true);
  });
});

test('formatTimeRange shows start and end, locally or in the meeting time zone', () => {
  const ny = meeting({ dueDate: '2026-10-20', dueTime: '14:00', endTime: '15:30', timeZone: 'America/New_York' });
  const opts = { hour: 'numeric', minute: '2-digit' };
  const there = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'America/New_York', timeZoneName: 'short' });
  const shortName = there.formatToParts(C.meetingStart(ny)).find((p) => p.type === 'timeZoneName').value;

  inZone('Europe/Berlin', () => {
    const here = new Intl.DateTimeFormat(undefined, opts);
    // 14:00-15:30 in New York is 20:00-21:30 in Berlin.
    assert.equal(C.formatTimeRange(ny), here.formatRange(new Date(2026, 9, 20, 20, 0), new Date(2026, 9, 20, 21, 30)));
    assert.equal(C.formatTimeRange(ny, { zone: true }), there.formatRange(C.meetingStart(ny), C.meetingEnd(ny)));
    assert.ok(C.formatTimeRange(ny, { zone: true }).includes(shortName));
    assert.ok(!C.formatTimeRange(ny).includes(shortName));

    // Just the start without an end time.
    assert.equal(C.formatTimeRange({ ...ny, endTime: '' }), C.formatTime('20:00'));
    assert.equal(C.formatTimeRange({ ...ny, endTime: '' }, { zone: true }), there.format(C.meetingStart(ny)));
  });
  if (/^en/.test(new Intl.DateTimeFormat().resolvedOptions().locale)) {
    assert.match(C.formatTimeRange(ny, { zone: true }), /^2:00\s–\s3:30\sPM EDT$/);
  }

  // Nothing without a time.
  assert.equal(C.formatTimeRange({ ...ny, dueTime: '' }), '');
  assert.equal(C.formatTimeRange(meeting()), '');

  // A meeting without a zone, asked for its zone: the device's own.
  inZone('Asia/Tokyo', () => {
    const local = meeting({ dueDate: '2026-10-20', dueTime: '09:00', endTime: '10:00' });
    const tokyo = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'Asia/Tokyo', timeZoneName: 'short' });
    assert.equal(
      C.formatTimeRange(local, { zone: true }),
      tokyo.formatRange(new Date(2026, 9, 20, 9, 0), new Date(2026, 9, 20, 10, 0))
    );
  });

  // Over local midnight: just the two times, no dates.
  const tokyoDay = meeting({ dueDate: '2026-10-20', dueTime: '09:00', endTime: '17:00', timeZone: 'Asia/Tokyo' });
  inZone('America/New_York', () => {
    const range = C.formatTimeRange(tokyoDay);
    assert.equal(range, `${C.formatTime('20:00')} – ${C.formatTime('04:00')}`);
    assert.doesNotMatch(range, /2026|10\/|\/20/);
  });

  // Browsers without formatRange join the two times. (Times not formatted
  // above: results are kept, and a browser never gains or loses formatRange.)
  const odd = meeting({ dueDate: '2026-10-20', dueTime: '13:10', endTime: '13:50', timeZone: 'America/New_York' });
  const descriptor = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, 'formatRange');
  delete Intl.DateTimeFormat.prototype.formatRange;
  try {
    inZone('Europe/Berlin', () => {
      assert.equal(C.formatTimeRange(odd), `${C.formatTime('19:10')} – ${C.formatTime('19:50')}`);
      assert.equal(
        C.formatTimeRange(odd, { zone: true }),
        `${there.format(C.meetingStart(odd))} – ${there.format(C.meetingEnd(odd))}`
      );
    });
  } finally {
    Object.defineProperty(Intl.DateTimeFormat.prototype, 'formatRange', descriptor);
  }

  // Kept results never mix up time zones: the same meeting seen from elsewhere.
  inZone('Asia/Tokyo', () => {
    const tokyo = new Intl.DateTimeFormat(undefined, opts);
    assert.equal(C.formatTimeRange(ny), tokyo.formatRange(new Date(2026, 9, 21, 3, 0), new Date(2026, 9, 21, 4, 30)));
  });
});

test('zoneLabel names a time zone by its city and its name at that time', () => {
  const longName = (tz, at) =>
    new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: 'long' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName').value;
  assert.equal(C.zoneLabel('America/New_York', SUMMER), `New York (${longName('America/New_York', SUMMER)})`);
  assert.equal(C.zoneLabel('America/New_York', WINTER), `New York (${longName('America/New_York', WINTER)})`);
  assert.notEqual(C.zoneLabel('America/New_York', SUMMER), C.zoneLabel('America/New_York', WINTER));
  assert.ok(C.zoneLabel('America/Argentina/Buenos_Aires', SUMMER).startsWith('Buenos Aires ('));
  assert.ok(C.zoneLabel('Asia/Kolkata', SUMMER).startsWith('Kolkata ('));
  assert.ok(C.zoneLabel('Asia/Calcutta', SUMMER).startsWith('Kolkata (')); // the old name Intl may use
  assert.equal(C.zoneLabel('UTC'), 'UTC');
  assert.equal(C.zoneLabel(''), '');
  assert.equal(C.zoneLabel('Nowhere/Special'), '');
  if (/^en/.test(new Intl.DateTimeFormat().resolvedOptions().locale)) {
    assert.equal(C.zoneLabel('America/New_York', SUMMER), 'New York (Eastern Daylight Time)');
    assert.equal(C.zoneLabel('America/New_York', WINTER), 'New York (Eastern Standard Time)');
  }
});

test('timeZoneOptions lists every zone with its offset, sorted', () => {
  const offsetOf = (label) => {
    const m = /^\S.* \(GMT([+−])(\d{2}):(\d{2})\)$/.exec(label);
    assert.ok(m, label);
    return (m[1] === '+' ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3]));
  };
  const checkSorted = (options) => {
    for (let i = 1; i < options.length; i += 1) {
      const a = options[i - 1];
      const b = options[i];
      const diff = offsetOf(a.label) - offsetOf(b.label);
      assert.ok(diff < 0 || (diff === 0 && a.label <= b.label), `${a.label} before ${b.label}`);
    }
  };

  for (const zone of ['Asia/Kolkata', 'America/New_York', 'UTC', 'Asia/Kathmandu']) {
    inZone(zone, () => {
      const options = C.timeZoneOptions(SUMMER);
      const ids = options.map((o) => o.id);
      assert.ok(ids.includes(C.localTimeZone()), zone);
      assert.ok(ids.includes('UTC'));
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(options.every((o) => Object.keys(o).join() === 'id,label'));
      checkSorted(options);
    });
  }

  const label = (now, ...ids) => {
    const options = C.timeZoneOptions(now);
    const found = options.find((o) => ids.includes(o.id));
    return found && found.label;
  };
  // City first (so typing a city finds it), then the zone's name, then the offset.
  const named = (text, city, offset) => text.startsWith(city) && text.endsWith(`(GMT${offset})`);
  assert.ok(named(label(SUMMER, 'America/New_York'), 'New York', '−04:00'));
  assert.ok(named(label(WINTER, 'America/New_York'), 'New York', '−05:00'));
  assert.ok(named(label(SUMMER, 'UTC'), 'UTC', '+00:00'));
  assert.ok(named(label(SUMMER, 'Asia/Kolkata', 'Asia/Calcutta'), 'Kolkata', '+05:30'));
  assert.ok(named(label(SUMMER, 'Pacific/Chatham'), 'Chatham', '+12:45'));
  assert.ok(named(label(WINTER, 'Pacific/Chatham'), 'Chatham', '+13:45'));
  assert.ok(named(label(SUMMER, 'Australia/Lord_Howe'), 'Lord Howe', '+10:30'));
  if (/^en/.test(new Intl.DateTimeFormat().resolvedOptions().locale)) {
    assert.equal(label(SUMMER, 'America/New_York'), 'New York — Eastern Time (GMT−04:00)');
  }

  // A saved zone the list spells differently is still offered; junk is not.
  const extra = C.timeZoneOptions(SUMMER, ['Asia/Kolkata', 'Nowhere/Special']).map((o) => o.id);
  assert.ok(extra.includes('Asia/Kolkata'));
  assert.ok(!extra.includes('Nowhere/Special'));

  // Browsers that can't list their zones get a shorter list of common ones.
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'supportedValuesOf');
  Object.defineProperty(Intl, 'supportedValuesOf', { ...descriptor, value: undefined });
  try {
    inZone('Asia/Kathmandu', () => {
      const options = C.timeZoneOptions(SUMMER);
      const ids = options.map((o) => o.id);
      assert.ok(options.length >= 40 && options.length < 100, String(options.length));
      for (const id of [
        'America/New_York',
        'America/Chicago',
        'America/Denver',
        'America/Phoenix',
        'America/Los_Angeles',
        'America/Anchorage',
        'Pacific/Honolulu',
        'Europe/London',
        'Asia/Kolkata',
        'Asia/Tokyo',
        'Australia/Sydney',
        'UTC',
      ]) {
        assert.ok(ids.includes(id), id);
      }
      // The device's own zone is always there.
      assert.ok(ids.includes(C.localTimeZone()));
      assert.ok(options.find((o) => o.id === C.localTimeZone()).label.startsWith('Kathmandu'));
      checkSorted(options);
    });
  } finally {
    Object.defineProperty(Intl, 'supportedValuesOf', descriptor);
  }
});

test('a meeting is "now" until its real end time', () => {
  const info = (dueTime, endTime, now = NOW) => C.dueInfo(meeting({ dueDate: '2026-10-14', dueTime, endTime }), now);
  const at = (h, m) => new Date(2026, 9, 14, h, m);

  // 9:00-11:00 is still on at 10:00; without an end it would be over.
  const long = info('09:00', '11:00');
  assert.equal(long.state, 'now');
  assert.equal(long.label, 'Happening now');
  assert.equal(long.minutes, -60);
  assert.equal(info('09:00', '').state, 'past');
  assert.equal(info('09:00', '11:00', at(10, 59)).state, 'now');
  const over = info('09:00', '11:00', at(11, 0));
  assert.equal(over.state, 'past');
  assert.equal(over.label, `Earlier today at ${C.formatTime('09:00')}`);

  // A three-hour interview is "now" all the way through.
  assert.equal(info('07:00', '12:00').state, 'now');
  assert.equal(info('07:00', '12:00').minutes, -180);

  // A short one ends early.
  assert.equal(info('09:30', '09:45').state, 'past');
  assert.equal(info('09:30', '').state, 'now');

  // Before the start, "now" still begins an hour ahead.
  assert.equal(info('11:00', '12:00').label, 'Starts in 60 minutes');
  assert.equal(info('11:01', '12:00').state, 'today');

  // The label shows the start; full adds the end.
  const later = info('14:00', '15:30');
  assert.equal(later.label, `Today at ${C.formatTime('14:00')}`);
  const m = meeting({ dueDate: '2026-10-14', dueTime: '14:00', endTime: '15:30' });
  assert.equal(later.full, `${C.formatDate(C.parseISODate('2026-10-14'), NOW)} at ${C.formatTimeRange(m)}`);
  assert.ok(!later.full.includes('('));
  assert.equal(info('14:00', '15:30', at(16, 0)).state, 'past');
  assert.equal(info('14:00', '15:30', at(15, 29)).state, 'now');
});

test('dueInfo shows a meeting in another time zone on its local day and time', () => {
  // 20:00 on Wednesday in New York is 09:00 on Thursday in Tokyo.
  const ny = meeting({ dueDate: '2026-10-14', dueTime: '20:00', endTime: '21:00', timeZone: 'America/New_York' });
  inZone('Asia/Tokyo', () => {
    const now = new Date(2026, 9, 14, 10, 0);
    const due = C.dueInfo(ny, now);
    assert.equal(due.days, 1);
    assert.equal(due.state, 'soon');
    assert.equal(due.label, `Tomorrow at ${C.formatTime('09:00')}`);
    assert.equal(due.minutes, 23 * 60);
    assert.equal(
      due.full,
      `${C.formatDate(new Date(2026, 9, 15), now)} at ${C.formatTimeRange(ny)} (${C.formatZoneTime(ny)})`
    );
    // The time there is on another date, so it says which.
    assert.ok(C.formatZoneTime(ny).startsWith(new Date(2026, 9, 14).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })));

    assert.equal(C.dueInfo(ny, new Date(2026, 9, 15, 7, 59)).state, 'today');
    assert.equal(C.dueInfo(ny, new Date(2026, 9, 15, 8, 0)).label, 'Starts in 60 minutes');
    assert.equal(C.dueInfo(ny, new Date(2026, 9, 15, 9, 0)).label, 'Starting now');
    assert.equal(C.dueInfo(ny, new Date(2026, 9, 15, 9, 59)).label, 'Happening now');
    const after = C.dueInfo(ny, new Date(2026, 9, 15, 10, 0));
    assert.equal(after.state, 'past');
    assert.equal(after.days, 0);
    assert.equal(after.label, `Earlier today at ${C.formatTime('09:00')}`);
    const nextDay = C.dueInfo(ny, new Date(2026, 9, 16, 8, 0));
    assert.equal(nextDay.state, 'past');
    assert.equal(nextDay.label, `Yesterday at ${C.formatTime('09:00')}`);
  });
  inZone('America/New_York', () => {
    // Same clocks: no second time in brackets.
    const due = C.dueInfo(ny, new Date(2026, 9, 14, 10, 0));
    assert.equal(due.state, 'today');
    assert.equal(due.label, `Today at ${C.formatTime('20:00')}`);
    assert.ok(!due.full.includes('('));
  });

  // A meeting without a time stays on its date, with the usual full text.
  const allDay = meeting({ dueDate: '2026-10-15', timeZone: 'Asia/Tokyo' });
  inZone('America/Los_Angeles', () => {
    const now = new Date(2026, 9, 14, 10, 0);
    const due = C.dueInfo(allDay, now);
    assert.equal(due.days, 1);
    assert.equal(due.minutes, null);
    assert.equal(due.full, C.formatDate(new Date(2026, 9, 15), now));
    assert.equal(C.dueInfo(allDay, new Date(2026, 9, 16, 10, 0)).state, 'past');
  });
});

test('meetings in another time zone land on the day they happen here', () => {
  inZone('Asia/Tokyo', () => {
    const now = new Date(2026, 9, 15, 7, 0); // Thursday morning in Tokyo
    // 20:00 on Wednesday in New York is 09:00 on Thursday in Tokyo.
    const ny = meeting({ id: 'ny', dueDate: '2026-10-14', dueTime: '20:00', timeZone: 'America/New_York' });
    const early = plan({ id: 'early', dueDate: '2026-10-15', dueTime: '08:30' });
    const late = plan({ id: 'late', dueDate: '2026-10-15', dueTime: '09:30' });
    const yesterday = meeting({ id: 'yesterday', dueDate: '2026-10-14', dueTime: '21:00' });

    const groups = C.groupForToday([late, ny, early, yesterday], now);
    assert.deepEqual(groups.today.map((p) => p.id), ['early', 'ny', 'late']);
    assert.deepEqual(groups.pastMeetings.map((p) => p.id), ['yesterday']);
    assert.deepEqual(C.sortPlans([late, yesterday, ny, early], 'deadline').map((p) => p.id), [
      'yesterday',
      'early',
      'ny',
      'late',
    ]);
    assert.equal(C.nextUp([late, ny], now).id, 'ny');

    const stats = C.computeStats([ny, early, late, yesterday], now);
    assert.equal(stats.dueToday, 3);
    assert.equal(stats.todayTotal, 3); // yesterday's meeting is over
    assert.equal(stats.overdue, 0);
  });

  inZone('America/Los_Angeles', () => {
    // 07:00 on Thursday in Tokyo is still 15:00 on Wednesday in Los Angeles.
    const now = new Date(2026, 9, 14, 10, 0);
    const tokyo = meeting({ id: 'tokyo', dueDate: '2026-10-15', dueTime: '07:00', timeZone: 'Asia/Tokyo' });
    const groups = C.groupForToday([tokyo], now);
    assert.deepEqual(groups.today.map((p) => p.id), ['tokyo']);
    assert.equal(groups.upcoming.length, 0);
    const stats = C.computeStats([tokyo], now);
    assert.equal(stats.dueToday, 1);
    assert.equal(stats.todayTotal, 1);
    // The next morning it is a past meeting, though its own date is "today" in Tokyo.
    const nextMorning = new Date(2026, 9, 15, 9, 0);
    assert.deepEqual(C.groupForToday([tokyo], nextMorning).pastMeetings.map((p) => p.id), ['tokyo']);
    assert.equal(C.computeStats([tokyo], nextMorning).todayTotal, 0);
  });
});

test('meetingICS writes a meeting in its own time zone as the same moment everywhere', () => {
  const m = meeting({
    id: 'z',
    title: 'Interview',
    company: 'Acme',
    dueDate: '2026-10-20',
    dueTime: '14:30',
    endTime: '15:45',
    timeZone: 'America/New_York',
    resume: PDF,
    coverLetter: LETTER,
  });
  const lines = (p) => C.meetingICS(p, NOW).replace(/\r\n /g, '').split('\r\n');
  const zoneLine = `Time zone: ${C.zoneLabel('America/New_York', C.meetingStart(m))}`;

  for (const zone of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
    inZone(zone, () => {
      const out = lines(m);
      assert.ok(out.includes('DTSTART:20261020T183000Z'), zone);
      assert.ok(out.includes('DTEND:20261020T194500Z'), zone);
      assert.ok(out.includes(`DESCRIPTION:Company: Acme\\n${zoneLine}`), zone);
      // Documents stay out of the file.
      const text = out.join('\n');
      for (const leak of [PDF.id, LETTER.id, PDF.name, LETTER.name]) assert.ok(!text.includes(leak), leak);
      // Without an end time: an hour.
      assert.ok(lines({ ...m, endTime: '' }).includes('DTEND:20261020T193000Z'), zone);
      // Winter in New York.
      const winter = lines({ ...m, dueDate: '2026-12-01' });
      assert.ok(winter.includes('DTSTART:20261201T193000Z'), zone);
      assert.ok(winter.includes('DTEND:20261201T204500Z'), zone);
    });
  }

  // Whole-day meetings stay whole days, and still name the zone.
  const allDay = C.meetingICS({ ...m, dueTime: '', endTime: '' }, NOW);
  assert.ok(allDay.includes('DTSTART;VALUE=DATE:20261020'));
  assert.ok(allDay.includes('DTEND;VALUE=DATE:20261021'));
  assert.ok(allDay.replace(/\r\n /g, '').includes('Time zone: New York'));
  assert.ok(!allDay.includes('VALARM'));

  // Without a zone: as before, the device's time and no zone line.
  inZone('America/Los_Angeles', () => {
    const local = lines({ ...m, timeZone: '' });
    assert.ok(local.includes('DTSTART:20261020T213000Z'));
    assert.ok(local.includes('DTEND:20261020T224500Z'));
    assert.ok(!local.join('\n').includes('Time zone'));
  });
});

test('older copies of a meeting keep its time zone, end time and documents', () => {
  const local = [
    meeting({
      id: 'm',
      dueDate: '2026-10-20',
      dueTime: '14:00',
      endTime: '15:00',
      timeZone: 'Asia/Kolkata',
      resume: PDF,
      coverLetter: LETTER,
    }),
  ];
  const later = new Date(2026, 9, 14, 11, 0).toISOString();
  // Written by a version without meetings (no kind)...
  const ancient = { title: 'Renamed', dueDate: '2026-10-20', dueTime: '14:00', updatedAt: later };
  // ...and by one with meetings but without time zones.
  const before = { ...ancient, kind: 'meeting', company: 'Acme' };

  for (const data of [ancient, before]) {
    const result = C.applyRemoteChanges(local, [{ id: 'm', data }], new Set(), NOW);
    const m = result[0];
    assert.equal(m.title, 'Renamed');
    assert.equal(m.kind, 'meeting');
    assert.equal(m.timeZone, 'Asia/Kolkata');
    assert.equal(m.endTime, '15:00');
    assert.deepEqual(m.resume, PDF);
    assert.deepEqual(m.coverLetter, LETTER);
    // Getting the same copy again is not a change.
    assert.equal(C.applyRemoteChanges(result, [{ id: 'm', data }], new Set(), NOW), result);

    const [imported] = C.importData([{ ...data, id: 'm' }], NOW, local);
    assert.equal(imported.timeZone, 'Asia/Kolkata');
    assert.deepEqual(imported.resume, PDF);
  }

  // An older copy that moved the start past the end loses the end time only.
  const moved = C.applyRemoteChanges(local, [{ id: 'm', data: { ...before, dueTime: '16:00' } }], new Set(), NOW)[0];
  assert.equal(moved.endTime, '');
  assert.equal(moved.timeZone, 'Asia/Kolkata');
  assert.deepEqual(moved.resume, PDF);

  // A current copy says what it means: cleared fields stay cleared.
  const cleared = { ...local[0], timeZone: '', endTime: '', resume: null, coverLetter: null, updatedAt: later };
  const [c] = C.applyRemoteChanges(local, [{ id: 'm', data: cleared }], new Set(), NOW);
  assert.deepEqual([c.timeZone, c.endTime, c.resume, c.coverLetter], ['', '', null, null]);

  // Turning it into a plan clears them too.
  const [p] = C.applyRemoteChanges(local, [{ id: 'm', data: { ...before, kind: 'plan' } }], new Set(), NOW);
  assert.deepEqual([p.kind, p.timeZone, p.endTime, p.resume, p.coverLetter], ['plan', '', '', null, null]);

  // Nothing to keep without a local meeting.
  assert.equal(C.keepMeetingDetails(before, undefined), before);
  assert.equal(C.keepMeetingDetails(before, plan({ id: 'm' })), before);
  assert.equal(C.keepMeetingDetails(null, local[0]), null);
  assert.equal(C.keepMeetingDetails(cleared, local[0]), cleared);
});

test('the sample meeting has a time zone and an end time', () => {
  const m = C.samplePlans(NOW).find(C.isMeeting);
  assert.equal(m.timeZone, C.localTimeZone());
  assert.equal(m.dueTime, '14:00');
  assert.equal(m.endTime, '15:00');
  assert.equal(C.meetingEnd(m) - C.meetingStart(m), 60 * 60 * 1000);
  assert.equal(C.zoneDiffers(m), false);
  assert.equal(m.resume, null);
  assert.equal(m.coverLetter, null);
});

/* --------------------------------------------------------- notifications */

const INTERVIEW = {
  title: 'Interview with Acme',
  company: 'Acme',
  dueDate: '2026-10-20',
  dueTime: '14:00',
  endTime: '15:00',
  timeZone: 'Europe/London',
  meetingUrl: 'https://zoom.us/j/1',
  jobUrl: 'https://example.com/jobs/1',
  resume: PDF,
  coverLetter: LETTER,
};

test('notifyChanges finds nothing when no emailed detail changed', () => {
  const base = meeting({ id: 'm', ...INTERVIEW });
  assert.deepEqual(C.notifyChanges(base, base), []);
  assert.deepEqual(C.notifyChanges(base, { ...base }), []);
  assert.deepEqual(C.notifyChanges({}, {}), []);
  // Notes, status, tags and steps are not emailed, so they never count.
  const busy = {
    ...base,
    description: 'Bring a notebook.',
    status: 'done',
    priority: 'low',
    tags: ['job-search'],
    checklist: [{ id: 's', text: 'Research the company', done: true }],
    order: 7,
    updatedAt: new Date(2026, 9, 15).toISOString(),
  };
  assert.deepEqual(C.notifyChanges(base, busy), []);
});

test('notifyChanges finds a change to each emailed detail', () => {
  const base = meeting({ id: 'm', ...INTERVIEW });
  const edits = {
    title: 'Second interview with Acme',
    company: 'Acme Ltd',
    dueDate: '2026-10-21',
    dueTime: '13:30',
    endTime: '16:00',
    timeZone: 'America/New_York',
    meetingUrl: 'https://zoom.us/j/2',
    jobUrl: 'https://example.com/jobs/2',
    resume: { ...PDF, id: 'b'.repeat(32) },
    coverLetter: null,
  };
  assert.deepEqual(C.NOTIFY_FIELDS, Object.keys(edits));
  for (const [field, value] of Object.entries(edits)) {
    assert.deepEqual(C.notifyChanges(base, { ...base, [field]: value }), [field], field);
  }
  // Every detail at once, listed in NOTIFY_FIELDS order.
  assert.deepEqual(C.notifyChanges(base, { ...base, ...edits }), C.NOTIFY_FIELDS);
});

test('notifyChanges ignores spaces around text and treats missing as empty', () => {
  const padded = {
    ...INTERVIEW,
    title: '  Interview with Acme \n',
    company: '\tAcme ',
    dueDate: ' 2026-10-20',
    dueTime: '14:00 ',
    timeZone: ' Europe/London ',
  };
  assert.deepEqual(C.notifyChanges(INTERVIEW, padded), []);
  assert.deepEqual(C.notifyChanges({ endTime: '' }, { endTime: undefined }), []);
  assert.deepEqual(C.notifyChanges({ endTime: null }, {}), []);
  assert.deepEqual(C.notifyChanges({ title: '   ' }, { title: '' }), []);
  // Spaces inside the text, and letter case, still count.
  assert.deepEqual(C.notifyChanges({ title: 'Acme  interview' }, { title: 'Acme interview' }), ['title']);
  assert.deepEqual(C.notifyChanges({ company: 'Acme' }, { company: 'ACME' }), ['company']);
});

test('notifyChanges compares links as cleanUrl sees them', () => {
  const base = { meetingUrl: 'https://zoom.us/j/1', jobUrl: 'https://example.com/jobs/1' };
  // Typed or pasted differently, but the same address.
  assert.deepEqual(C.notifyChanges(base, { meetingUrl: '  zoom.us/j/1 ', jobUrl: 'HTTPS://Example.com/jobs/1' }), []);
  // A link cleanUrl refuses is no link at all.
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'not a link', 'http://localhost/x', 42, null]) {
    assert.deepEqual(C.notifyChanges({ meetingUrl: '' }, { meetingUrl: bad }), [], String(bad));
    assert.deepEqual(C.notifyChanges({ jobUrl: bad }, {}), [], String(bad));
  }
  // So a refused link in place of a real one means the link is gone.
  assert.deepEqual(C.notifyChanges(base, { ...base, meetingUrl: 'javascript:alert(1)' }), ['meetingUrl']);
  assert.deepEqual(C.notifyChanges(base, { ...base, jobUrl: 'https://example.com/jobs/1?ref=2' }), ['jobUrl']);
  assert.deepEqual(C.notifyChanges({}, { jobUrl: 'example.com/jobs/1' }), ['jobUrl']);
});

test('notifyChanges compares documents by file id only', () => {
  const base = { resume: PDF, coverLetter: LETTER };
  // The same file under a new name or size isn't news.
  const renamed = { resume: { ...PDF, name: 'CV final.pdf', size: 1 }, coverLetter: { id: LETTER.id } };
  assert.deepEqual(C.notifyChanges(base, renamed), []);
  assert.deepEqual(C.notifyChanges({ resume: null }, { resume: undefined }), []);
  // Added, removed or replaced.
  assert.deepEqual(C.notifyChanges({}, base), ['resume', 'coverLetter']);
  assert.deepEqual(C.notifyChanges({ ...base, resume: null }, base), ['resume']);
  assert.deepEqual(C.notifyChanges(base, { ...base, resume: undefined }), ['resume']);
  assert.deepEqual(C.notifyChanges(base, { ...base, coverLetter: null }), ['coverLetter']);
  assert.deepEqual(C.notifyChanges(base, { ...base, coverLetter: { ...LETTER, id: 'c'.repeat(32) } }), ['coverLetter']);
  assert.deepEqual(C.notifyChanges(base, { resume: LETTER, coverLetter: PDF }), ['resume', 'coverLetter']);
});

test('notifyChanges lists changes in NOTIFY_FIELDS order and copes with a missing version', () => {
  // Keys in a different order than NOTIFY_FIELDS.
  const after = { coverLetter: LETTER, jobUrl: 'example.com/jobs/1', title: 'Interview', dueDate: '2026-10-20' };
  const expected = ['title', 'dueDate', 'jobUrl', 'coverLetter'];
  assert.deepEqual(C.notifyChanges({}, after), expected);
  for (const missing of [undefined, null, 'meeting', 42]) {
    assert.deepEqual(C.notifyChanges(missing, after), expected, String(missing));
    assert.deepEqual(C.notifyChanges(after, missing), expected, String(missing));
  }
  assert.deepEqual(C.notifyChanges(undefined, undefined), []);
  assert.deepEqual(C.notifyChanges(null, {}), []);
  // A new meeting lists every detail it has, and nothing it leaves empty.
  const fresh = meeting({ ...INTERVIEW, endTime: '', timeZone: '', coverLetter: null });
  assert.deepEqual(
    C.notifyChanges(undefined, fresh),
    C.NOTIFY_FIELDS.filter((f) => !['endTime', 'timeZone', 'coverLetter'].includes(f))
  );
  // Always a new array, so a caller can't change NOTIFY_FIELDS by accident.
  const all = C.notifyChanges({}, INTERVIEW);
  assert.deepEqual(all, C.NOTIFY_FIELDS);
  assert.notEqual(all, C.NOTIFY_FIELDS);
});
