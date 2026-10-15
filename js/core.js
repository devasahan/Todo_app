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
  const KINDS = ['plan', 'meeting'];
  const KIND_LABELS = { plan: 'Plan', meeting: 'Meeting' };
  const COMPANY_MAX = 120;
  const URL_MAX = 2000;
  const FILE_NAME_MAX = 120;
  // How long a meeting without an end time is assumed to last, and how early
  // any meeting counts as "now".
  const MEETING_WINDOW_MIN = 60;
  const MINUTE_MS = 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

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

  // Like formatTime, but leaves out ":00" on the hour ("2 PM", "2:30 PM").
  function formatShortTime(time) {
    const [h, m] = time.split(':').map(Number);
    // Only a 12-hour clock can drop ":00" ("2 PM"); on a 24-hour clock a bare
    // "14" would read like a day of the month.
    const cycle = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
    if (m || (cycle !== 'h11' && cycle !== 'h12')) return formatTime(time);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric' });
  }

  function formatDate(date, now = new Date()) {
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return date.toLocaleDateString(undefined, opts);
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  /* ----------------------------------------------------------- time zones */

  // A meeting's date, start and end are wall-clock times in its own time zone
  // (an IANA id such as "America/New_York"), so "2 PM in New York" stays 2 PM
  // in New York wherever the planner is opened. '' means the device's own
  // time zone: meetings saved before time zones existed keep working as before.

  // Building an Intl formatter takes about a tenth of a millisecond, so they
  // (and a few results) are kept. A cache is emptied once it gets big, so odd
  // input can never make it grow forever.
  function cached(map, key, make, limit = 1000) {
    let value = map.get(key);
    if (value === undefined) {
      if (map.size >= limit) map.clear();
      value = make();
      map.set(key, value);
    }
    return value;
  }

  const partFormats = new Map();

  // Reads the wall clock of `timeZone` at a moment, as numbers.
  // null for a time zone this browser doesn't know.
  function partFormat(timeZone) {
    return cached(partFormats, timeZone, () => {
      try {
        return new Intl.DateTimeFormat('en-US', {
          timeZone,
          hourCycle: 'h23',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
        });
      } catch {
        return null;
      }
    });
  }

  function isValidTimeZone(tz) {
    return typeof tz === 'string' && tz !== '' && tz.length <= 100 && partFormat(tz) !== null;
  }

  // The device's own time zone, or '' when the browser can't tell.
  function localTimeZone() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return isValidTimeZone(tz) ? tz : '';
    } catch {
      return '';
    }
  }

  // How far `timeZone` is ahead of UTC at the moment `ms`, in milliseconds
  // (New York in summer: minus 4 hours). Its wall clock read as if it were
  // UTC, minus the moment itself.
  function zoneOffset(ms, timeZone) {
    const p = {};
    for (const part of partFormat(timeZone).formatToParts(new Date(ms))) p[part.type] = Number(part.value);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
    return wall - Math.floor(ms / 1000) * 1000;
  }

  const zoneWalls = new Map();

  // { time, offset }: the moment (ms) the clocks in `timeZone` show
  // `date time`, and the zone's UTC offset at that moment.
  function zoneWall(date, time, timeZone) {
    return cached(
      zoneWalls,
      `${date}|${time}|${timeZone}`,
      () => {
        const [y, mo, d] = date.split('-').map(Number);
        const [h, mi] = time.split(':').map(Number);
        const wall = Date.UTC(y, mo - 1, d, h, mi);
        // The offsets a day before and a day after cover any change of the
        // clocks near this time. An offset fits when the zone really has it
        // at the moment it points to.
        const before = zoneOffset(wall - DAY_MS, timeZone);
        const after = zoneOffset(wall + DAY_MS, timeZone);
        const fits = [...new Set([before, after])].filter((o) => zoneOffset(wall - o, timeZone) === o);
        // The night the clocks go back, the time happens twice: take the
        // first. The night they go forward, it is skipped: move on by the
        // jump (2:30 becomes 3:30). Both are what a local Date does.
        if (fits.length) {
          const offset = Math.max(...fits);
          return { time: wall - offset, offset };
        }
        const moment = wall - before;
        return { time: moment, offset: zoneOffset(moment, timeZone) };
      },
      2000
    );
  }

  /*
   * The moment the clocks in `timeZone` show `date` ("YYYY-MM-DD") at `time`
   * ("HH:MM"). With no time zone (''), the device's own local time.
   * null when the date or time is not valid.
   */
  function zonedInstant(date, time, timeZone = '') {
    if (!parseISODate(date) || !isValidTime(time)) return null;
    if (!isValidTimeZone(timeZone)) {
      const [y, mo, d] = date.split('-').map(Number);
      const [h, mi] = time.split(':').map(Number);
      return new Date(y, mo - 1, d, h, mi);
    }
    return new Date(zoneWall(date, time, timeZone).time);
  }

  // The time zone a meeting's times are in; '' for plans and for meetings
  // without one (those use the device's own time).
  function meetingZone(plan) {
    return isMeeting(plan) && isValidTimeZone(plan.timeZone) ? plan.timeZone : '';
  }

  // When a meeting starts, or null without a date and time.
  function meetingStart(plan) {
    return plan ? zonedInstant(plan.dueDate, plan.dueTime, meetingZone(plan)) : null;
  }

  // When a meeting ends, or null when it has no end time.
  function meetingEnd(plan) {
    const start = meetingStart(plan);
    if (!start || !isValidTime(plan.endTime) || plan.endTime <= plan.dueTime) return null;
    const end = zonedInstant(plan.dueDate, plan.endTime, meetingZone(plan));
    return end > start ? end : null;
  }

  // The end time, or an hour after the start when none is set.
  function meetingEndOrDefault(plan) {
    const start = meetingStart(plan);
    if (!start) return null;
    return meetingEnd(plan) || new Date(start.getTime() + MEETING_WINDOW_MIN * MINUTE_MS);
  }

  /*
   * The date and time a plan is due on this device: for a meeting in another
   * time zone, the local day and time of its start ("2 PM in New York" is
   * 8 PM in Berlin). Everything else as saved. Plain Date getters only: this
   * runs inside sort comparisons.
   */
  function localDue(plan) {
    const start = meetingZone(plan) ? meetingStart(plan) : null;
    if (!start) return { date: plan.dueDate, time: plan.dueTime };
    return { date: toISODate(start), time: `${pad(start.getHours())}:${pad(start.getMinutes())}` };
  }

  // True when a meeting's time zone is set and its clocks differ from this
  // device's at the meeting's start, so both times are worth showing.
  function zoneDiffers(plan) {
    const zone = meetingZone(plan);
    if (!zone || !parseISODate(plan.dueDate) || !isValidTime(plan.dueTime)) return false;
    const { time, offset } = zoneWall(plan.dueDate, plan.dueTime, zone);
    return Math.round(offset / MINUTE_MS) !== Math.round(-new Date(time).getTimezoneOffset());
  }

  const timeFormats = new Map();
  const timeRanges = new Map();

  // "2:00 PM", or "2:00 PM EDT" with `named`.
  function timeFormat(timeZone, named) {
    return cached(timeFormats, `${timeZone}|${named}`, () => {
      const opts = { hour: 'numeric', minute: '2-digit', timeZone };
      if (named) opts.timeZoneName = 'short';
      return new Intl.DateTimeFormat(undefined, opts);
    });
  }

  // A copy of a local time whose UTC clock shows the same hours and minutes.
  // Local times are formatted from these, so no kept formatter depends on the
  // device's time zone (which can change while the page is open).
  function wallCopy(date) {
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()));
  }

  /*
   * A meeting's start and end ("2:00 – 3:00 PM"), or just the start without
   * an end time. Local time by default; `zone: true` gives the meeting's own
   * time zone with its short name ("2:00 – 3:00 PM EDT"). '' without a time.
   */
  function formatTimeRange(plan, { zone = false } = {}) {
    const start = meetingStart(plan);
    if (!start) return '';
    const end = meetingEnd(plan);
    const timeZone = zone ? meetingZone(plan) || localTimeZone() : '';
    const format = timeZone ? timeFormat(timeZone, true) : timeFormat('UTC', false);
    const from = timeZone ? start : wallCopy(start);
    const to = end && (timeZone ? end : wallCopy(end));
    if (!to) return format.format(from);
    // formatRange is slow (it runs on every render), so its results are kept too.
    return cached(
      timeRanges,
      `${from.getTime()}|${to.getTime()}|${timeZone}`,
      () => {
        // In its own zone a meeting starts and ends on the same day. In local
        // time it may not, and formatRange would then add both dates: just
        // the times read better.
        const sameDay = timeZone || from.getUTCDate() === to.getUTCDate();
        if (sameDay && typeof format.formatRange === 'function') return format.formatRange(from, to);
        return `${format.format(from)} – ${format.format(to)}`;
      },
      2000
    );
  }

  // Intl still knows a few cities by their old names.
  const RENAMED_CITIES = {
    Calcutta: 'Kolkata',
    Kiev: 'Kyiv',
    Saigon: 'Ho Chi Minh',
    Katmandu: 'Kathmandu',
    Rangoon: 'Yangon',
  };

  // "America/Argentina/Buenos_Aires" gives "Buenos Aires".
  function zoneCity(tz) {
    const city = tz.split('/').pop().replace(/_/g, ' ');
    return RENAMED_CITIES[city] || city;
  }

  const nameFormats = new Map();

  // "New York (Eastern Daylight Time)": the city in the id and the zone's
  // name at the moment `at` (summer and winter names differ). '' when invalid.
  function zoneLabel(tz, at = new Date()) {
    if (!isValidTimeZone(tz)) return '';
    if (tz === 'UTC') return 'UTC';
    const format = cached(nameFormats, tz, () => new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: 'long' }));
    const name = (format.formatToParts(at).find((part) => part.type === 'timeZoneName') || {}).value;
    const city = zoneCity(tz);
    return name && name !== city ? `${city} (${name})` : city;
  }

  // "−04:00" (with a real minus sign) for an offset in milliseconds.
  const genericFormats = new Map();

  // "Eastern Time": the zone's name without summer/winter, or '' when the
  // browser has none (it would only repeat "GMT+3").
  function genericZoneName(tz, at) {
    try {
      const format = cached(genericFormats, tz, () => new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: 'longGeneric' }));
      const name = (format.formatToParts(at).find((part) => part.type === 'timeZoneName') || {}).value || '';
      return /GMT|UTC[+−-]/.test(name) ? '' : name;
    } catch {
      return ''; // older browsers don't know 'longGeneric'
    }
  }

  function formatOffset(ms) {
    const minutes = Math.round(ms / MINUTE_MS);
    const abs = Math.abs(minutes);
    return `${minutes < 0 ? '\u2212' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }

  // Offered when the browser can't list its time zones.
  const COMMON_TIME_ZONES = [
    'Pacific/Honolulu', 'America/Adak', 'America/Anchorage', 'America/Los_Angeles', 'America/Vancouver',
    'America/Phoenix', 'America/Denver', 'America/Edmonton', 'America/Chicago', 'America/Winnipeg',
    'America/Mexico_City', 'America/New_York', 'America/Toronto', 'America/Halifax', 'America/St_Johns',
    'America/Sao_Paulo', 'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin',
    'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Warsaw', 'Europe/Athens',
    'Europe/Istanbul', 'Europe/Moscow', 'Africa/Lagos', 'Africa/Johannesburg', 'Africa/Cairo', 'Africa/Nairobi',
    'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Singapore',
    'Asia/Manila', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Seoul', 'Asia/Tokyo', 'Australia/Sydney',
    'Australia/Melbourne', 'Pacific/Auckland', 'UTC',
  ];

  /*
   * Choices for a time zone menu: [{ id, label }] with labels such as
   * "(GMT−04:00) New York" (the offset at `now`), sorted by offset, then
   * name. Always offers the device's own zone, UTC and any id in `include`
   * (a meeting's saved zone, which another browser may spell differently).
   */
  function timeZoneOptions(now = new Date(), include = []) {
    let ids = [];
    try {
      if (typeof Intl.supportedValuesOf === 'function') ids = Intl.supportedValuesOf('timeZone');
    } catch {
      ids = [];
    }
    if (!ids.length) ids = COMMON_TIME_ZONES;
    const unique = new Set([...ids, 'UTC', localTimeZone(), ...include].filter(isValidTimeZone));
    return [...unique]
      .map((id) => {
        const offset = zoneOffset(now.getTime(), id);
        // City first, so typing "New York" (or "Eastern") in the list finds it.
        const city = zoneCity(id);
        const generic = genericZoneName(id, now);
        const name = generic && generic !== city ? `${city} — ${generic}` : city;
        return { id, offset, label: `${name} (GMT${formatOffset(offset)})` };
      })
      // Plain comparisons: ids are ASCII, and localeCompare is slow on 400 zones.
      .sort((a, b) => a.offset - b.offset || (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : 1))
      .map(({ id, label }) => ({ id, label }));
  }

  /*
   * Describes how close a plan's deadline is.
   * state: none | overdue | today | soon | later | done
   * Meetings use meetingInfo instead and are never overdue.
   */
  function dueInfo(plan, now = new Date()) {
    if (plan.kind === 'meeting') return meetingInfo(plan, now);
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

  /*
   * Describes when a meeting starts. A meeting is "now" from 60 minutes
   * before its start until it ends (its end time, or 60 minutes after the
   * start without one), then "past".
   * state: none | now | past | today | soon | later | done
   * `minutes` is the time until the start (negative once it has begun),
   * or null when no time is set.
   * Days and times are this device's: a meeting in another time zone shows
   * up on the day it happens here. `full` adds the end time and, when its
   * zone's clocks differ, the time there: "Tue, Oct 20 at 8:00 – 9:00 PM
   * (2:00 – 3:00 PM EDT)".
   */
  // The time in the meeting's own zone, with its date when that isn't the
  // local date: "Thu, Oct 15, 2:00 – 3:00 PM EDT".
  function formatZoneTime(plan) {
    const range = formatTimeRange(plan, { zone: true });
    if (!range) return '';
    const own = parseISODate(plan.dueDate);
    if (!own || localDue(plan).date === plan.dueDate) return range;
    return `${own.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${range}`;
  }

  function meetingInfo(plan, now) {
    if (!parseISODate(plan.dueDate)) {
      return { state: 'none', label: 'Date not set', full: '', days: null, minutes: null };
    }

    const local = localDue(plan);
    const due = parseISODate(local.date);
    const days = daysBetween(now, due);
    const start = meetingStart(plan);
    const at = start ? ` at ${formatTime(local.time)}` : '';
    const date = formatDate(due, now);
    const when = `${date}${at}`;
    let full = when;
    if (start) {
      full = `${date} at ${formatTimeRange(plan)}`;
      if (zoneDiffers(plan)) full += ` (${formatZoneTime(plan)})`;
    }
    // `|| 0` turns -0 into 0, so the last half-minute still reads "Starting now".
    const minutes = start ? Math.ceil((start - now) / MINUTE_MS) || 0 : null;
    const end = start ? meetingEndOrDefault(plan).getTime() : null;
    const info = (state, label) => ({ state, label, full, days, minutes });

    if (plan.status === 'done') return info('done', when);
    if (start && now.getTime() >= start.getTime() - MEETING_WINDOW_MIN * MINUTE_MS && now.getTime() < end) {
      if (minutes > 0) return info('now', `Starts in ${plural(minutes, 'minute')}`);
      return info('now', minutes === 0 ? 'Starting now' : 'Happening now');
    }
    if (days < 0 || (start && now.getTime() >= end)) {
      if (days === 0) return info('past', `Earlier today${at}`);
      if (days === -1) return info('past', `Yesterday${at}`);
      return info('past', when);
    }
    if (days === 0) return info('today', `Today${at}`);
    if (days === 1) return info('soon', `Tomorrow${at}`);
    if (days < 7) {
      const weekday = due.toLocaleDateString(undefined, { weekday: 'long' });
      return info(days <= 3 ? 'soon' : 'later', `${weekday}${at}`);
    }
    // Unlike plans, the time is kept: it matters for a meeting.
    return info('later', when);
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

  /* ---------------------------------------------------------------- links */

  /*
   * The only gate a link passes through: returns a clean http(s) address,
   * or '' for anything else (javascript:, data:, local hosts, user names...).
   * "zoom.us/j/1" becomes "https://zoom.us/j/1". cleanUrl(cleanUrl(x)) is
   * always cleanUrl(x).
   */
  function cleanUrl(value) {
    if (typeof value !== 'string') return '';
    let s = value.trim();
    if (!s || s.length > URL_MAX || /[\s\u0000-\u001f\u007f-\u009f]/.test(s)) return '';
    if (!/^[a-z][a-z\d+.-]*:/i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
    let url;
    try {
      url = new URL(s);
    } catch {
      return '';
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (!url.hostname.includes('.') || url.username !== '' || url.password !== '') return '';
    // The parser escapes a double quote everywhere except in the host name.
    if (url.href.length > URL_MAX || url.href.includes('"')) return '';
    return url.href;
  }

  // Finds the link in pasted invitation text ("Join Zoom Meeting https://…").
  // A single word is returned as it is, so cleanUrl can still fix "zoom.us/j/1".
  function extractUrl(value) {
    const t = String(value || '').trim();
    if (!/\s/.test(t)) return t;
    // Bounded, and trailing punctuation is trimmed with a loop: a regex over
    // a huge pasted text would freeze the page.
    const match = /https?:\/\/[^\s<>"'`]{1,2000}/i.exec(t);
    if (!match) return t;
    let url = match[0];
    while (url && '.,;:!?)]}>\'"'.includes(url[url.length - 1])) url = url.slice(0, -1);
    return url;
  }

  // "https://www.linkedin.com/jobs/1" gives "linkedin.com".
  function linkHost(url) {
    const u = cleanUrl(url);
    return u ? new URL(u).hostname.replace(/^www\./, '') : '';
  }

  /* ---------------------------------------------------------------- plans */

  function isMeeting(plan) {
    return Boolean(plan) && plan.kind === 'meeting';
  }

  function meetingTitle(company) {
    return company ? `Interview with ${company}` : '';
  }

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

  /*
   * An uploaded PDF (a meeting's resume or cover letter) as the server
   * describes it: { id, name, size }, or null for anything else. The id is
   * all the server needs; the name is only shown.
   */
  function normalizeFile(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.id !== 'string' || !/^[0-9a-f]{32}$/.test(value.id)) return null;
    if (!Number.isSafeInteger(value.size) || value.size < 0) return null;
    const raw = typeof value.name === 'string' ? value.name.replace(CONTROL_CHARS, '').trim() : '';
    // Counted in characters, not UTF-16 units, so no emoji is cut in half.
    const name = Array.from(raw).slice(0, FILE_NAME_MAX).join('').trim();
    return { id: value.id, name: name || 'document.pdf', size: value.size };
  }

  // Validates and fills in any plan-shaped object (also used for imports).
  function normalizePlan(raw, now = new Date()) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const stamp = now.toISOString();
    const status = STATUSES.includes(r.status) ? r.status : 'todo';
    const dueDate = parseISODate(r.dueDate) ? r.dueDate : '';
    const dueTime = dueDate && isValidTime(r.dueTime) ? r.dueTime : '';
    const updatedAt = isStamp(r.updatedAt) ? r.updatedAt : stamp;
    const kind = r.kind === 'meeting' ? 'meeting' : 'plan';
    const meeting = kind === 'meeting';
    // Only meetings keep a company and links; saving one as a plan clears them.
    const company = meeting ? text(r.company, COMPANY_MAX).replace(/\s+/g, ' ').trim() : '';
    // A meeting ends on the day it starts, so its end time must be later.
    const endTime = meeting && dueTime && isValidTime(r.endTime) && r.endTime > dueTime ? r.endTime : '';

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
      title: text(r.title, 200).trim() || (meeting ? meetingTitle(company) || 'Untitled meeting' : 'Untitled plan'),
      description: text(r.description, 5000),
      dueDate,
      dueTime,
      status,
      priority: PRIORITIES.includes(r.priority) ? r.priority : 'medium',
      // Always written. A stored plan without `kind` was saved by an older
      // version of Dayplan (see fromOlderVersion). Never stop writing it.
      kind,
      company,
      meetingUrl: meeting ? cleanUrl(r.meetingUrl) : '',
      jobUrl: meeting ? cleanUrl(r.jobUrl) : '',
      // Also always written (empty on plans). dueDate, dueTime and endTime
      // are wall-clock times in timeZone; '' is the device's own time zone.
      timeZone: meeting && isValidTimeZone(r.timeZone) ? r.timeZone : '',
      endTime,
      resume: meeting ? normalizeFile(r.resume) : null,
      coverLetter: meeting ? normalizeFile(r.coverLetter) : null,
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
        // A little randomness so two devices adding at once don't get the same order.
        order: (peers.length ? Math.min(...peers) - 1 : 0) - Math.random() / 2,
        createdAt: stamp,
        updatedAt: stamp,
        startedAt: status === 'in_progress' ? stamp : '',
        completedAt: status === 'done' ? stamp : '',
      },
      now
    );
  }

  // The time of a change: now, but always later than the version it replaces,
  // so an edit made on a device whose clock runs behind still counts as newer.
  function nextStamp(previous, now = new Date()) {
    const before = Date.parse(previous || '');
    const time = Number.isNaN(before) ? now.getTime() : Math.max(now.getTime(), before + 1);
    return new Date(time).toISOString();
  }

  // Returns a copy of the plan in the new status, keeping timestamps honest.
  function withStatus(plan, status, now = new Date()) {
    if (!STATUSES.includes(status) || plan.status === status) return plan;
    const stamp = now.toISOString();
    return {
      ...plan,
      status,
      updatedAt: nextStamp(plan.updatedAt, now),
      startedAt: status === 'todo' ? '' : plan.startedAt || (status === 'in_progress' ? stamp : ''),
      completedAt: status === 'done' ? stamp : '',
    };
  }

  // Plans cycle To do → In progress → Done; meetings toggle To do ↔ Done.
  function nextStatus(status, kind) {
    if (kind === 'meeting') return status === 'done' ? 'todo' : 'done';
    return STATUSES[(STATUSES.indexOf(status) + 1) % STATUSES.length];
  }

  /*
   * Moves a plan into `toStatus`, placed before `beforeId` (or at the end).
   * Only the moved plan changes: it gets an order between its new
   * neighbours, so moving one plan never rewrites (and re-syncs) the others.
   */
  function movePlan(plans, id, toStatus, beforeId = null, now = new Date()) {
    const plan = plans.find((p) => p.id === id);
    if (!plan || !STATUSES.includes(toStatus)) return plans;

    const column = plans.filter((p) => p.status === toStatus && p.id !== id).sort(byOrder);
    let index = beforeId ? column.findIndex((p) => p.id === beforeId) : -1;
    if (index < 0) index = column.length;

    const above = column[index - 1];
    const below = column[index];
    // Somewhere in the middle of the gap (not exactly halfway), so two devices
    // moving cards into the same gap at once don't pick the same number.
    const jitter = 0.25 + Math.random() / 2;
    let order;
    if (above && below) order = above.order + (below.order - above.order) * jitter;
    else if (below) order = below.order - 1 - jitter / 2;
    else if (above) order = above.order + 1 + jitter / 2;
    else order = 0;

    const moved = { ...withStatus(plan, toStatus, now), order, updatedAt: nextStamp(plan.updatedAt, now) };
    if (!above || !below || (order > above.order && order < below.order)) {
      return plans.map((p) => (p.id === id ? moved : p));
    }

    // No room between the neighbours (equal orders, or after very many moves
    // into one gap): re-space just the cards packed around the gap, never the
    // whole column, so as few plans as possible change.
    let lo = index - 1;
    let hi = index;
    const packed = (a, b) => !(b.order - a.order > Math.max(1, Math.abs(a.order)) * 1e-9);
    while (lo > 0 && packed(column[lo - 1], column[lo])) lo -= 1;
    while (hi < column.length - 1 && packed(column[hi], column[hi + 1])) hi += 1;
    const cluster = column.slice(lo, hi + 1);
    cluster.splice(index - lo, 0, moved);
    const floor = lo > 0 ? column[lo - 1].order : column[lo].order - cluster.length - 1;
    const ceiling = hi < column.length - 1 ? column[hi + 1].order : column[hi].order + cluster.length + 1;
    const step = (ceiling - floor) / (cluster.length + 1);
    const respaced = new Map(cluster.map((p, i) => [p.id, floor + step * (i + 1)]));
    return plans.map((p) => {
      if (p.id === id) return { ...moved, order: respaced.get(id) };
      return respaced.has(p.id) ? { ...p, order: respaced.get(p.id), updatedAt: nextStamp(p.updatedAt, now) } : p;
    });
  }

  function checklistProgress(plan) {
    const total = plan.checklist.length;
    const done = plan.checklist.filter((item) => item.done).length;
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  /* ---------------------------------------------------- filtering/sorting */

  function matchesFilters(plan, filters = {}) {
    const { query = '', tag = '', priority = '', kind = '' } = filters;
    if (kind && plan.kind !== kind) return false;
    if (tag && !plan.tags.includes(tag)) return false;
    if (priority && plan.priority !== priority) return false;
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const haystack = [
      plan.title,
      plan.company,
      plan.description,
      ...plan.tags.map((t) => `#${t}`),
      ...plan.checklist.map((item) => item.text),
    ]
      .join('\n')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  }

  // Timed deadlines sort before all-day ones; no deadline sorts last.
  // Meetings in another time zone sort by when they happen on this device.
  function deadlineKey(plan) {
    const { date, time } = localDue(plan);
    return date ? `${date} ${time || '24:00'}` : '~';
  }

  // Manual order, with the id as a tie-break so every device shows the same order.
  function byOrder(a, b) {
    return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  function byDeadline(a, b) {
    const ka = deadlineKey(a);
    const kb = deadlineKey(b);
    // Plain comparison on purpose: localeCompare would sort "~" before digits.
    return (ka < kb ? -1 : ka > kb ? 1 : 0) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  }

  function sortPlans(plans, mode = 'manual') {
    const list = [...plans];
    switch (mode) {
      case 'deadline':
        return list.sort((a, b) => byDeadline(a, b) || byOrder(a, b));
      case 'priority':
        return list.sort(
          (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byDeadline(a, b) || byOrder(a, b)
        );
      case 'newest':
        return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || byOrder(a, b));
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
  // in the first section it qualifies for. Meetings from earlier days go to
  // pastMeetings; this morning's meetings stay in today.
  function groupForToday(plans, now = new Date()) {
    const todayKey = toISODate(now);
    const groups = {
      overdue: [],
      today: [],
      inProgress: [],
      upcoming: [],
      pastMeetings: [],
      doneToday: [],
      later: [],
    };

    for (const plan of plans) {
      if (plan.status === 'done') {
        if (completedOn(plan) === todayKey) groups.doneToday.push(plan);
        continue;
      }
      const due = dueInfo(plan, now);
      if (due.state === 'past' && due.days < 0) groups.pastMeetings.push(plan);
      else if (due.state === 'overdue') groups.overdue.push(plan);
      else if (due.state === 'today' || due.state === 'now' || due.state === 'past') groups.today.push(plan);
      else if (plan.status === 'in_progress') groups.inProgress.push(plan);
      else if (due.days !== null && due.days <= 7) groups.upcoming.push(plan);
      else groups.later.push(plan);
    }

    for (const key of ['overdue', 'today', 'inProgress', 'upcoming', 'pastMeetings', 'later']) {
      groups[key].sort((a, b) => byDeadline(a, b) || byOrder(a, b));
    }
    groups.pastMeetings.reverse(); // newest first
    groups.doneToday.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    return groups;
  }

  // The single plan that deserves attention right now: a meeting that is
  // about to start (or has just started) comes before everything else.
  function nextUp(plans, now = new Date()) {
    // With back-to-back interviews, the one closest to its start time wins:
    // the next one about to begin rather than the previous one still running.
    const away = (p) => Math.abs(dueInfo(p, now).minutes);
    const meetingNow = plans
      .filter((p) => isMeeting(p) && dueInfo(p, now).state === 'now')
      .sort((a, b) => away(a) - away(b) || byDeadline(a, b) || byOrder(a, b))[0];
    if (meetingNow) return meetingNow;
    const g = groupForToday(plans, now);
    return (
      g.overdue[0] ||
      g.today.find((p) => dueInfo(p, now).state !== 'past') ||
      g.inProgress[0] ||
      g.upcoming[0] ||
      null
    );
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
        if (localDue(plan).date === todayKey) stats.dueToday += 1;
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
    // Meetings from earlier days are over, so they don't count as remaining.
    const remaining = plans.filter((p) => {
      if (p.status === 'done') return false;
      const { date } = localDue(p);
      return date && date <= todayKey && !(p.kind === 'meeting' && date < todayKey);
    }).length;
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

  /* -------------------------------------------------------- calendar file */

  // Escapes a TEXT value for a calendar file (RFC 5545). The backslash goes first.
  function icsText(value) {
    return String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  }

  // "2026-10-20T12:30:00.000Z" becomes "20261020T123000Z".
  const icsStamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const icsDate = (date) => toISODate(date).replace(/-/g, '');

  // Splits a line longer than 75 bytes (UTF-8) into continuation lines that
  // start with a space. Goes one character at a time, so none is ever split.
  function foldLine(line, encoder) {
    const parts = [];
    let current = '';
    let size = 0;
    for (const ch of line) {
      const bytes = encoder.encode(ch).length;
      if (size + bytes > 75) {
        parts.push(current);
        current = ' ';
        size = 1;
      }
      current += ch;
      size += bytes;
    }
    parts.push(current);
    return parts.join('\r\n');
  }

  /*
   * A calendar file (.ics) for a meeting, with a reminder 15 minutes before
   * when it has a time. Times are written in UTC, so calendar apps show the
   * same moment the planner does, wherever the meeting's time zone is.
   * Attached documents stay out of the file. Returns '' for plans and
   * undated meetings.
   */
  function meetingICS(plan, now = new Date()) {
    const due = parseISODate(plan.dueDate);
    if (!isMeeting(plan) || !due) return '';
    const start = meetingStart(plan);
    const hasTime = start !== null;
    const zone = meetingZone(plan);
    const meetingUrl = cleanUrl(plan.meetingUrl);
    const jobUrl = cleanUrl(plan.jobUrl);

    const details = [
      plan.company ? `Company: ${plan.company}` : '',
      meetingUrl ? `Meeting link: ${meetingUrl}` : '',
      jobUrl ? `Job description: ${jobUrl}` : '',
      zone ? `Time zone: ${zoneLabel(zone, start || zonedInstant(plan.dueDate, '12:00', zone))}` : '',
    ].filter(Boolean);
    const notes = String(plan.description || '').trim();
    const description = [details.join('\n'), notes].filter(Boolean).join('\n\n');

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Dayplan//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${icsText(plan.id)}@dayplan`,
      `DTSTAMP:${icsStamp(now)}`,
    ];
    if (hasTime) {
      lines.push(`DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(meetingEndOrDefault(plan))}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(due)}`, `DTEND;VALUE=DATE:${icsDate(addDays(due, 1))}`);
    }
    lines.push(`SUMMARY:${icsText(plan.title)}`);
    // URL is a URI value, so it isn't escaped; cleanUrl leaves no spaces or control characters.
    if (meetingUrl) lines.push(`LOCATION:${icsText(meetingUrl)}`, `URL:${meetingUrl}`);
    lines.push(`DESCRIPTION:${icsText(description)}`);
    if (hasTime) {
      // RFC 5545 requires a DESCRIPTION in a DISPLAY alarm.
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(plan.title)}`, 'TRIGGER:-PT15M', 'END:VALARM');
    }
    lines.push('END:VEVENT', 'END:VCALENDAR');

    const encoder = new TextEncoder();
    return `${lines.map((line) => foldLine(line, encoder)).join('\r\n')}\r\n`;
  }

  // "interview-with-acme-inc-2026-10-20.ics"
  function icsFileName(plan) {
    const slug =
      String(plan.title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/, '') || 'meeting';
    return `${slug}${parseISODate(plan.dueDate) ? `-${plan.dueDate}` : ''}.ics`;
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

  // True for a stored plan written by an older version of Dayplan, which
  // didn't know about meetings and so never wrote `kind`.
  function fromOlderVersion(raw) {
    return raw !== null && typeof raw === 'object' && !Object.prototype.hasOwnProperty.call(raw, 'kind');
  }

  // An older version drops the fields it doesn't know about, so its copy of a
  // meeting arrives without them. Keep the details of the meeting we have.
  // A copy that says kind: 'plan' was written on purpose and does convert it.
  // Versions from before time zones wrote `kind` but not `timeZone`: their
  // copy of a meeting keeps its zone, end time and documents the same way.
  function keepMeetingDetails(raw, current) {
    if (!current || current.kind !== 'meeting' || raw === null || typeof raw !== 'object') return raw;
    const newer = {
      timeZone: current.timeZone,
      endTime: current.endTime,
      resume: current.resume,
      coverLetter: current.coverLetter,
    };
    if (fromOlderVersion(raw)) {
      return {
        ...raw,
        kind: 'meeting',
        company: current.company,
        meetingUrl: current.meetingUrl,
        jobUrl: current.jobUrl,
        ...newer,
      };
    }
    if (raw.kind === 'meeting' && !Object.prototype.hasOwnProperty.call(raw, 'timeZone')) return { ...raw, ...newer };
    return raw;
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
      const current = byId.get(change.id);
      const incoming = normalizePlan({ ...keepMeetingDetails(change.data, current), id: change.id }, now);
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

  // `current` is the plans already loaded: a meeting in it keeps its details
  // when the imported copy was written by an older version (see keepMeetingDetails).
  function importData(input, now = new Date(), current = []) {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    const list = Array.isArray(data) ? data : data && Array.isArray(data.plans) ? data.plans : null;
    if (!list) throw new Error('This file does not contain any plans.');
    const byId = new Map(current.map((p) => [p.id, p]));
    const seen = new Set();
    return list
      .filter((item) => item && typeof item === 'object')
      .map((item) => normalizePlan(keepMeetingDetails(item, byId.get(item.id)), now))
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
        title: 'Interview with Northwind Traders',
        kind: 'meeting',
        company: 'Northwind Traders',
        description: 'Ask about the team and the next steps.',
        dueDate: day(2),
        dueTime: '14:00',
        endTime: '15:00',
        timeZone: localTimeZone(),
        status: 'todo',
        priority: 'high',
        tags: ['job-search'],
        // example.com on purpose: sample links must never lead anywhere real.
        meetingUrl: 'https://example.com/interview',
        jobUrl: 'https://example.com/jobs/product-designer',
        checklist: [step('Research the company'), step('Prepare three questions')],
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
    KINDS,
    KIND_LABELS,
    uid,
    toISODate,
    parseISODate,
    startOfDay,
    addDays,
    addMonths,
    daysBetween,
    isValidTime,
    formatTime,
    formatShortTime,
    formatDate,
    isValidTimeZone,
    localTimeZone,
    zonedInstant,
    meetingStart,
    meetingEnd,
    meetingEndOrDefault,
    localDue,
    zoneDiffers,
    formatTimeRange,
    formatZoneTime,
    zoneLabel,
    timeZoneOptions,
    dueInfo,
    parseQuickAdd,
    cleanUrl,
    extractUrl,
    linkHost,
    isMeeting,
    meetingTitle,
    normalizeTag,
    normalizeFile,
    normalizePlan,
    createPlan,
    withStatus,
    nextStatus,
    nextStamp,
    movePlan,
    checklistProgress,
    matchesFilters,
    sortPlans,
    allTags,
    groupForToday,
    nextUp,
    computeStats,
    monthGrid,
    meetingICS,
    icsFileName,
    changedPlanIds,
    fromOlderVersion,
    keepMeetingDetails,
    applyRemoteChanges,
    exportData,
    importData,
    samplePlans,
  };
});
