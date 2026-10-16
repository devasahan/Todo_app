"""Meeting emails for Dayplan, using only the Python standard library.

When the admin schedules, changes or cancels a meeting, approved accounts
that asked for it get an email: what the meeting is, when it is (in the
meeting's own time zone and, when their clocks differ, in theirs), its
links, and a calendar file (.ics) that adds it to a calendar. Notes, steps
and tags never leave Dayplan, and the PDFs stay there too.

Emails go out through Gmail (smtp.gmail.com, port 587, STARTTLS), the only
mail server a free PythonAnywhere account can reach, signed in with a Gmail
app password. The address and app password are kept in a small JSON file
outside the repository that only its owner can read, never in the database.
The password is never logged, printed, or sent back by any page, and no
error message from here ever contains it.

This module only writes and sends the emails. Who gets them, and when, is
decided in dayplan_api.py.
"""
import html
import json
import os
import re
import secrets
import smtplib
import socket
import ssl
from collections import namedtuple
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import format_datetime, formataddr, make_msgid
from pathlib import Path
from urllib.parse import quote, unquote

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python 3.8: times are shown as saved, without converting them
    ZoneInfo = None

DEFAULT_HOST = 'smtp.gmail.com'
DEFAULT_PORT = 587
DEFAULT_FROM_NAME = 'Dayplan'
# The parts of a meeting the emails are about. Changing anything else
# (notes, steps, tags, its status...) never sends one.
NOTIFY_FIELDS = (
    'title', 'company', 'dueDate', 'dueTime', 'endTime', 'timeZone', 'meetingUrl', 'jobUrl', 'resume', 'coverLetter',
)
KINDS = ('new', 'changed', 'cancelled', 'restored', 'reminder')
WHEN_FIELDS = ('dueDate', 'dueTime', 'endTime', 'timeZone')
URL_FIELDS = ('meetingUrl', 'jobUrl')
FILE_FIELDS = ('resume', 'coverLetter')
# How long a meeting without an end time is assumed to last (MEETING_WINDOW_MIN in js/core.js).
MEETING_WINDOW_MIN = 60
# Lengths as in js/core.js.
URL_MAX = 2000
TITLE_MAX = 200
COMPANY_MAX = 120
FILE_NAME_MAX = 120
SUBJECT_MAX = 150
# The same check dayplan_api.py makes when an account is created.
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
# ...plus characters that would let one address read as several in a To header.
ADDRESS_UNSAFE = re.compile(r'[\x00-\x1f\x7f-\x9f<>(),;:"\[\]\\]')
DATE_RE = re.compile(r'(\d{4})-(\d{2})-(\d{2})')
TIME_RE = re.compile(r'([01]\d|2[0-3]):([0-5]\d)')
# An IANA time zone name such as America/New_York, Etc/GMT+3 or UTC.
ZONE_RE = re.compile(r'[A-Z][A-Za-z0-9_+-]*(?:/[A-Z][A-Za-z0-9_+-]*)*')
# Control characters, and the Unicode line and paragraph separators.
CONTROL_RE = re.compile('[\x00-\x1f\x7f-\x9f  ]')
WEEKDAYS = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')
MONTHS = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')
# Time zone ids still use a few old city names (as in js/core.js).
RENAMED_CITIES = {
    'Calcutta': 'Kolkata',
    'Kiev': 'Kyiv',
    'Saigon': 'Ho Chi Minh',
    'Katmandu': 'Kathmandu',
    'Rangoon': 'Yangon',
}
SETUP_COMMAND = 'python3 ~/Todo_app/dayplan_api.py setup-email'
NOT_SET_UP = 'Email is not set up yet. Run {} in a PythonAnywhere console.'.format(SETUP_COMMAND)

SUBJECTS = {
    'new': 'New meeting',
    'changed': 'Meeting changed',
    'cancelled': 'Meeting cancelled',
    'restored': 'Meeting back on',
    'reminder': 'Meeting details',
}
# {} is the meeting's title. A headline without one gets a Title line below it.
HEADLINES = {
    'new': 'New meeting: {}',
    'changed': 'Meeting changed: {}',
    'cancelled': 'This meeting was cancelled',
    'restored': 'This meeting is back on',
    'reminder': 'Meeting details: {}',
}
INTROS = {
    'new': 'A meeting was added to the Dayplan schedule.',
    'changed': 'A meeting on the Dayplan schedule was changed.',
    'cancelled': 'It was taken off the Dayplan schedule. If you added it to your calendar, you can remove it there.',
    'restored': 'It was cancelled earlier and is on the Dayplan schedule again.',
    'reminder': 'Here are the details of this meeting on the Dayplan schedule.',
}
FOOTER = (
    'You get these emails because you have an approved account on Dayplan. To stop them, open Dayplan, '
    'click your account button and turn off “Email me about meeting changes”.'
)


class MailError(Exception):
    """Email could not be sent. The message is plain English, safe to show the
    admin, and never contains the password."""


# ------------------------------------------------------------------ settings

def _config(data):
    """The settings with defaults filled in, or None without a username and password."""
    if not isinstance(data, dict):
        return None
    username, password = data.get('username'), data.get('password')
    if not isinstance(username, str) or not username.strip() or not isinstance(password, str) or not password:
        return None
    host, port, from_name = data.get('host'), data.get('port'), data.get('from_name')
    if isinstance(port, str) and port.strip().isdigit():
        port = int(port.strip())
    if not isinstance(port, int) or isinstance(port, bool) or not 0 < port < 65536:
        port = DEFAULT_PORT
    return {
        'host': host.strip() if isinstance(host, str) and host.strip() else DEFAULT_HOST,
        'port': port,
        'username': username.strip(),
        'password': password,
        'from_name': from_name.strip() if isinstance(from_name, str) and from_name.strip() else DEFAULT_FROM_NAME,
    }


def load_config(path):
    """The email settings saved at `path`: {host, port, username, password, from_name}.

    None when the file is missing, can't be read, isn't JSON, or has no
    username or password.
    """
    try:
        with open(str(path), encoding='utf-8') as handle:
            data = json.load(handle)
    except (OSError, ValueError):  # a file that isn't UTF-8 is a ValueError too
        return None
    return _config(data)


def save_config(path, config):
    """Saves the email settings so that only this account can read them (mode 0600).

    The folder is created (mode 0700) if needed. The file is written to a new
    file next to it first and then moved over it, so a crash halfway never
    leaves half a file, and at no point can anyone else read the password.
    """
    data = _config(config)
    if data is None:
        raise ValueError('An email address and password are needed.')
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.parent / '.{}.{}.tmp'.format(path.name, secrets.token_hex(8))
    fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            if hasattr(os, 'fchmod'):
                os.fchmod(handle.fileno(), 0o600)  # 0600 whatever the umask
            json.dump(data, handle, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(str(temp), str(path))
    except BaseException:
        try:
            os.unlink(str(temp))
        except OSError:
            pass
        raise


def delete_config(path):
    """Removes the saved email settings. True if there was a file to remove."""
    try:
        os.remove(str(path))
    except FileNotFoundError:
        return False
    return True


# --------------------------------------------------------------- time zones

def _tz(name):
    """The time zone for a valid name, or None when it can't be loaded (no zoneinfo)."""
    if ZoneInfo is None:
        return timezone.utc if name == 'UTC' else None
    try:
        return ZoneInfo(name)
    except (KeyError, ValueError, OSError):  # ZoneInfoNotFoundError is a KeyError
        return None


def valid_zone(name):
    """True for an IANA time zone name such as America/New_York or UTC.

    Without zoneinfo (Python 3.8) only the shape of the name can be checked.
    """
    if not isinstance(name, str) or not name or len(name) > 64 or '..' in name or name.startswith('/'):
        return False
    if not ZONE_RE.fullmatch(name):
        return False
    return ZoneInfo is None or _tz(name) is not None


# ------------------------------------------------------------------ meetings

def _plain(text):
    """`text` with any lone surrogate (which can't be written as UTF-8) replaced."""
    return text.encode('utf-16', 'surrogatepass').decode('utf-16', 'replace')


def _one_line(value, limit=None):
    """Text on a single line: line breaks and control characters become spaces,
    runs of spaces one. Cut to `limit` characters with an ellipsis."""
    text = ' '.join(CONTROL_RE.sub(' ', _plain(value if isinstance(value, str) else '')).split())
    if limit and len(text) > limit:
        text = text[:limit - 1].rstrip() + '…'
    return text


def _string(value):
    if value is None or isinstance(value, (dict, list, tuple)):
        return ''
    return str(value).strip()


def _file(value):
    """A meeting's resume or cover letter as {'id', 'name'}, or None."""
    if not isinstance(value, dict) or not isinstance(value.get('id'), str) or not value['id'].strip():
        return None
    return {'id': value['id'].strip(), 'name': _one_line(value.get('name'), FILE_NAME_MAX) or 'document.pdf'}


def snapshot(meeting):
    """The parts of a meeting an email is about: {'id', 'kind'} and NOTIFY_FIELDS.

    Text is stripped ('' when missing); the resume and cover letter are
    {'id', 'name'} or None. It can be stored as JSON, to remember what the
    last email said, and passed back in wherever a meeting is expected.
    """
    data = meeting if isinstance(meeting, dict) else {}
    snap = {'id': _string(data.get('id')), 'kind': _string(data.get('kind'))}
    for key in NOTIFY_FIELDS:
        snap[key] = _file(data.get(key)) if key in FILE_FIELDS else _string(data.get(key))
    return snap


def changed_fields(before, after):
    """The NOTIFY_FIELDS (in that order) that differ between two meetings or snapshots.

    Links count as changed only when the cleaned link differs, and documents
    only when a different file is attached (or one is added or removed).
    """
    old, new = snapshot(before), snapshot(after)
    changed = []
    for key in NOTIFY_FIELDS:
        a, b = old[key], new[key]
        if key in URL_FIELDS:
            a, b = clean_url(a), clean_url(b)
        elif key in FILE_FIELDS:
            a, b = (a or {}).get('id'), (b or {}).get('id')
        if a != b:
            changed.append(key)
    return changed


# --------------------------------------------------------------------- links

# Characters a browser percent-encodes in each part of a link.
_PATH_ESCAPE = frozenset(' "<>`{}')
_QUERY_ESCAPE = frozenset(' "#<>\'')
_FRAGMENT_ESCAPE = frozenset(' "<>`')


def _escape(part, unsafe):
    return ''.join(quote(ch, safe='') if ch in unsafe or ord(ch) > 0x7e else ch for ch in part)


def _remove_dots(path):
    """'/a/b/../c' gives '/a/c', as a browser tidies a link."""
    segments = path.split('/')[1:]
    kept = []
    for index, segment in enumerate(segments):
        lower = segment.lower()
        last = index == len(segments) - 1
        if lower in ('.', '%2e'):
            if last:
                kept.append('')
        elif lower in ('..', '.%2e', '%2e.', '%2e%2e'):
            if kept:
                kept.pop()
            if last:
                kept.append('')
        else:
            kept.append(segment)
    return '/' + '/'.join(kept)


def clean_url(value):
    """A clean http(s) link, or '' for anything else (javascript:, data:, local
    hosts, user names...), like cleanUrl in js/core.js.

    "zoom.us/j/1" becomes "https://zoom.us/j/1". Links the app saved come
    back unchanged, and clean_url(clean_url(x)) is always clean_url(x). Host
    names are held to letters, digits, dots, hyphens and underscores, a little
    stricter than a browser.
    """
    if not isinstance(value, str):
        return ''
    text = value.strip()
    if not text or len(text) > URL_MAX or re.search(r'[\s\x00-\x1f\x7f-\x9f]', text):
        return ''
    if not re.match(r'[a-z][a-z\d+.-]*:', text, re.I):
        text = 'https://' + text.lstrip('/')
    scheme, rest = text.split(':', 1)
    scheme = scheme.lower()
    if scheme not in ('http', 'https'):
        return ''
    # As in a browser: any slashes after "https:" are skipped, and a backslash
    # before the query counts as a slash.
    rest = rest.lstrip('/\\')
    ends = [i for i in (rest.find('?'), rest.find('#')) if i >= 0]
    end = min(ends) if ends else len(rest)
    rest = rest[:end].replace('\\', '/') + rest[end:]
    authority, path, query, fragment = re.fullmatch(r'([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?', rest).groups()
    if '@' in authority or '[' in authority:
        return ''  # a user name or password, or an IPv6 address
    host, _, port = authority.partition(':')
    if port:
        if not re.fullmatch(r'[0-9]+', port) or int(port) > 65535:
            return ''
        port = '' if int(port) == {'http': 80, 'https': 443}[scheme] else str(int(port))
    try:
        host = unquote(host, errors='strict').encode('idna').decode('ascii').lower()
        path = _escape(_remove_dots(path or '/'), _PATH_ESCAPE)
        query = None if query is None else _escape(query, _QUERY_ESCAPE)
        fragment = None if fragment is None else _escape(fragment, _FRAGMENT_ESCAPE)
    except (UnicodeError, ValueError):
        return ''
    if '.' not in host or not re.fullmatch(r'[a-z0-9_.-]+', host):
        return ''
    href = '{}://{}{}{}{}{}'.format(
        scheme, host, ':' + port if port else '', path,
        '' if query is None else '?' + query, '' if fragment is None else '#' + fragment,
    )
    if len(href) > URL_MAX or '"' in href:
        return ''
    return href


# --------------------------------------------------------------------- times

# When a meeting is. day: a date or None. start, end: datetimes or None;
# in the meeting's own time zone when `tz` is known, otherwise as saved
# (naive). zone: the meeting's valid time zone name, '' for local time.
_Times = namedtuple('_Times', 'day start end zone tz')


def _date(value):
    match = DATE_RE.fullmatch(value) if isinstance(value, str) else None
    if not match:
        return None
    try:
        day = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:  # an impossible date such as 2026-02-31
        return None
    # Room for a day either side, so no conversion can run off the calendar.
    return day if 1 < day.year < 9999 else None


def _time(value):
    match = TIME_RE.fullmatch(value) if isinstance(value, str) else None
    return (int(match.group(1)), int(match.group(2))) if match else None


def _wall(day, clock, tz):
    """The moment the clocks in `tz` show `clock` on `day` (naive without a time zone)."""
    wall = datetime(day.year, day.month, day.day, clock[0], clock[1])
    if tz is None:
        return wall
    # Through UTC and back, as in the app: a time the clocks skip (2:30 the
    # night they go forward) moves on by the jump, and one they show twice
    # (the night they go back) is the first.
    return wall.replace(tzinfo=tz).astimezone(timezone.utc).astimezone(tz)


def _times(snap):
    day = _date(snap['dueDate'])
    zone = snap['timeZone'] if valid_zone(snap['timeZone']) else ''
    tz = _tz(zone) if zone else None
    start = end = None
    begins = _time(snap['dueTime']) if day else None
    if begins:
        start = _wall(day, begins, tz)
        ends = _time(snap['endTime'])
        # A meeting ends on the day it starts, so only a later end time counts.
        if ends and snap['endTime'] > snap['dueTime']:
            end = _wall(day, ends, tz)
            if end <= start:
                end = None
    return _Times(day, start, end, zone, tz)


def _day(day, year=True):
    """'Thu, Oct 22, 2026', or 'Thu, Oct 22' without the year."""
    text = '{}, {} {}'.format(WEEKDAYS[day.weekday()], MONTHS[day.month - 1], day.day)
    return '{}, {}'.format(text, day.year) if year else text


def _clock(moment):
    """('2:00', 'PM')."""
    return '{}:{:02d}'.format(moment.hour % 12 or 12, moment.minute), 'AM' if moment.hour < 12 else 'PM'


def _abbreviation(moment):
    """'EDT'; 'GMT+3' or 'GMT-3:30' for a zone known only by its offset ('+03'); '' without a zone."""
    if moment.tzinfo is None:
        return ''
    name = moment.tzname() or ''
    if re.fullmatch(r'[A-Za-z]+', name):
        return name
    minutes = int(moment.utcoffset().total_seconds() // 60)
    hours, rest = divmod(abs(minutes), 60)
    if not minutes:
        return 'GMT'
    return 'GMT{}{}{}'.format('+' if minutes > 0 else '-', hours, ':{:02d}'.format(rest) if rest else '')


def _range(start, end=None):
    """'2:00 – 3:00 PM EDT', '11:30 AM – 12:30 PM', '11:30 PM – Fri, Oct 23, 12:30 AM',
    or just '2:00 PM EDT' without an end."""
    clock, half = _clock(start)
    zone = _abbreviation(start)
    if end is None:
        text = '{} {}'.format(clock, half)
    else:
        end_clock, end_half = _clock(end)
        end_zone = _abbreviation(end)
        if end.date() != start.date():
            text = '{} {} – {}, {} {}'.format(clock, half, _day(end.date(), False), end_clock, end_half)
        elif end_zone != zone:  # the clocks changed during the meeting
            return '{} {} {} – {} {} {}'.format(clock, half, zone, end_clock, end_half, end_zone)
        elif half == end_half:
            text = '{} – {} {}'.format(clock, end_clock, end_half)
        else:
            text = '{} {} – {} {}'.format(clock, half, end_clock, end_half)
    return '{} {}'.format(text, zone) if zone else text


def _city(zone):
    """'New York' for America/New_York; '' for UTC and other zones without a city."""
    if '/' not in zone or zone.startswith('Etc/'):
        return ''
    city = zone.rsplit('/', 1)[-1].replace('_', ' ')
    return RENAMED_CITIES.get(city, city)


def _when(times, year=True):
    """'Thu, Oct 22, 2026, 2:00 – 3:00 PM EDT (New York time)'; 'Thu, Oct 22, 2026'
    without a time; 'No date set' without a date."""
    if times.day is None:
        return 'No date set'
    if times.start is None:
        return _day(times.day, year)
    text = '{}, {}'.format(_day(times.start.date(), year), _range(times.start, times.end))
    if not times.zone:
        return text + ' (local time)'  # no time zone: the time on whatever clock you read it on, as in the app
    place = _city(times.zone) or ('' if times.tz else times.zone)
    return '{} ({} time)'.format(text, place) if place else text


def _short_when(times):
    """The start for a subject line: 'Thu, Oct 22, 2:00 PM EDT' ('' without a date)."""
    if times.day is None:
        return ''
    if times.start is None:
        return _day(times.day, False)
    text = '{}, {}'.format(_day(times.start.date(), False), _range(times.start))
    if times.zone and times.tz is None:  # no zoneinfo: no abbreviation to show
        text += ' ({} time)'.format(_city(times.zone) or times.zone)
    return text


def _your_time(times, zone):
    """The meeting's time on the recipient's clocks, when those differ from the meeting's."""
    if times.start is None or times.tz is None or not valid_zone(zone):
        return ''
    tz = _tz(zone)
    if tz is None:
        return ''
    start = times.start.astimezone(tz)
    if start.utcoffset() == times.start.utcoffset():
        return ''
    end = times.end.astimezone(tz) if times.end is not None else None
    return '{}, {}'.format(_day(start.date(), False), _range(start, end))


def _zone_label(times):
    """'New York (EDT)' for the calendar file's notes."""
    if times.zone == 'UTC':
        return 'UTC'
    city = _city(times.zone) or times.zone
    if times.tz is None:
        return city
    moment = times.start or _wall(times.day, (12, 0), times.tz)
    return '{} ({})'.format(city, _abbreviation(moment))


# ------------------------------------------------------------- calendar file

def _ics_text(value):
    """Escapes a TEXT value for a calendar file (RFC 5545). The backslash goes first."""
    text = _plain(str(value)).replace('\\', '\\\\').replace(';', '\\;').replace(',', '\\,')
    text = re.sub(r'\r\n|\r|\n', r'\\n', text)
    return re.sub('[\x00-\x1f\x7f-\x9f]', '', text)


def _fold(line):
    """Splits a line longer than 75 bytes (UTF-8) into continuation lines that
    start with a space, one character at a time so none is ever split."""
    parts, current, size = [], '', 0
    for ch in line:
        width = len(ch.encode('utf-8'))
        if size + width > 75:
            parts.append(current)
            current, size = ' ', 1
        current += ch
        size += width
    parts.append(current)
    return '\r\n'.join(parts)


def _ics_moment(moment):
    """'20261022T180000Z' for an aware time (in UTC), '20261022T140000' for a naive one."""
    stamp = '{:04d}{:02d}{:02d}T{:02d}{:02d}{:02d}'.format(
        *(moment.astimezone(timezone.utc) if moment.tzinfo else moment).timetuple()[:6]
    )
    return stamp + 'Z' if moment.tzinfo else stamp


def _ics_date(day):
    return '{:04d}{:02d}{:02d}'.format(day.year, day.month, day.day)


def _ics(snap, times, title, company, meeting_url, job_url, sequence, now):
    """A calendar file for the meeting, like meetingICS in js/core.js but without notes.

    Times are written in UTC, so calendar apps show the same moment the
    planner does. A meeting without a time zone gets floating times (the
    same clock time wherever it is opened), as in the app. Without zoneinfo,
    a zoned time is written with its time zone's name (TZID) instead.
    """
    details = [
        'Company: ' + company if company else '',
        'Meeting link: ' + meeting_url if meeting_url else '',
        'Job description: ' + job_url if job_url else '',
        'Time zone: ' + _zone_label(times) if times.zone else '',
    ]
    lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Dayplan//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        'UID:{}@dayplan'.format(_ics_text(snap['id'])),
        'DTSTAMP:' + _ics_moment(now),
        'SEQUENCE:{}'.format(sequence),
    ]
    if times.start is not None:
        start = times.start.astimezone(timezone.utc) if times.tz else times.start
        end = times.end.astimezone(timezone.utc) if times.tz and times.end else times.end
        end = end or start + timedelta(minutes=MEETING_WINDOW_MIN)
        tzid = ';TZID=' + times.zone if times.zone and times.tz is None else ''
        lines += ['DTSTART{}:{}'.format(tzid, _ics_moment(start)), 'DTEND{}:{}'.format(tzid, _ics_moment(end))]
    else:
        lines += [
            'DTSTART;VALUE=DATE:' + _ics_date(times.day),
            'DTEND;VALUE=DATE:' + _ics_date(times.day + timedelta(days=1)),
        ]
    lines.append('SUMMARY:' + _ics_text(title))
    # URL is a URI value, so it isn't escaped; clean_url leaves no spaces or control characters.
    if meeting_url:
        lines += ['LOCATION:' + _ics_text(meeting_url), 'URL:' + meeting_url]
    lines.append('DESCRIPTION:' + _ics_text('\n'.join(line for line in details if line)))
    if times.start is not None:
        # RFC 5545 requires a DESCRIPTION in a DISPLAY alarm.
        lines += ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + _ics_text(title), 'TRIGGER:-PT15M', 'END:VALARM']
    lines += ['END:VEVENT', 'END:VCALENDAR']
    return '\r\n'.join(_fold(line) for line in lines) + '\r\n'


def _ics_file_name(title, due_date):
    """'interview-with-acme-inc-2026-10-20.ics', as icsFileName in js/core.js."""
    slug = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')[:40].rstrip('-') or 'meeting'
    return '{}-{}.ics'.format(slug, due_date) if _date(due_date) else slug + '.ics'


# -------------------------------------------------------------------- emails

def _valid_address(address):
    return (
        isinstance(address, str) and len(address) <= 254
        and EMAIL_RE.fullmatch(address) is not None and not ADDRESS_UNSAFE.search(address)
    )


def _message(config, recipient, subject, now):
    """A new email with its headers set. Every header is a single line, so no
    text from a meeting can add headers (or recipients) of its own."""
    config = _config(config)
    if config is None:
        raise MailError(NOT_SET_UP)
    address = recipient.strip() if isinstance(recipient, str) else ''
    if not _valid_address(address):
        raise ValueError('Not a valid email address.')
    msg = EmailMessage()
    msg['Subject'] = _one_line(subject, SUBJECT_MAX)
    msg['From'] = formataddr((_one_line(config['from_name'], 100) or DEFAULT_FROM_NAME, _one_line(config['username'])))
    msg['To'] = address
    msg['Date'] = format_datetime(now, usegmt=True)
    msg['Message-ID'] = make_msgid(domain='dayplan')
    msg['Auto-Submitted'] = 'auto-generated'  # asks mail servers not to send out-of-office replies
    return msg


def _utc(now):
    if now is None:
        return datetime.now(timezone.utc)
    return now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now.astimezone(timezone.utc)


def _title(snap):
    """The meeting's title on one line, with the app's fallbacks."""
    company = _one_line(snap['company'], COMPANY_MAX)
    return (
        _one_line(snap['title'], TITLE_MAX)
        or ('Interview with ' + company if company else '')
        or 'Untitled meeting'
    )


def _documents(snap):
    """'Resume and cover letter are in Dayplan.' (names only: the PDFs are never attached)."""
    if snap['resume'] and snap['coverLetter']:
        return 'Resume and cover letter are in Dayplan.'
    if snap['resume']:
        return 'Resume is in Dayplan.'
    if snap['coverLetter']:
        return 'Cover letter is in Dayplan.'
    return ''


def _was_now(label, old, new):
    """'Company: was Acme, now Globex' (old is None when it isn't known)."""
    if old is None:
        return '{}: now {}'.format(label, new) if new else '{}: removed'.format(label)
    if old == new or not (old or new):
        return ''
    if old and new:
        return '{}: was {}, now {}'.format(label, old, new)
    if new:
        return '{}: added {}'.format(label, new)
    return '{}: removed (was {})'.format(label, old)


def _change_lines(changes, before, after, times):
    """The 'What changed' list. The date, times and time zone make one When line."""
    lines = []
    if any(key in changes for key in WHEN_FIELDS):
        now_text = _when(times)
        was_text = _when(_times(before)) if before is not None else None
        if was_text is None:
            lines.append('When: now ' + now_text)
        elif was_text != now_text:
            lines.append('When: was {}, now {}'.format(was_text, now_text))
    texts = (
        ('company', 'Company', lambda snap: _one_line(snap['company'], COMPANY_MAX)),
        ('title', 'Title', lambda snap: _one_line(snap['title'], TITLE_MAX)),
        ('meetingUrl', 'Meeting link', lambda snap: clean_url(snap['meetingUrl'])),
        ('jobUrl', 'Job description link', lambda snap: clean_url(snap['jobUrl'])),
    )
    for key, label, read in texts:
        if key in changes:
            line = _was_now(label, read(before) if before is not None else None, read(after))
            if line:
                lines.append(line)
    for key, label in (('resume', 'Resume'), ('coverLetter', 'Cover letter')):
        if key not in changes:
            continue
        old, new = (before[key] if before is not None else None), after[key]
        if before is None:
            word = 'updated' if new else 'removed'
        elif old and new:
            word = 'replaced'
        else:
            word = 'added' if new else 'removed' if old else ''
        if word:
            lines.append('{}: {}'.format(label, word))
    return lines


def _html(headline, intro, rows, change_lines, notes, site, cancelled):
    """A simple HTML version of the email. Every value is escaped, and only
    clean http(s) links become links."""
    e = html.escape
    font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
    out = [
        '<!DOCTYPE html>',
        '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>',
        '<body style="margin:0;padding:0;background:#f7f8fa;">',
        '<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:{};'
        'font-size:15px;line-height:1.5;color:#111827;">'.format(font),
        '<div style="background:#ffffff;border:1px solid #e5e7ec;border-radius:10px;padding:20px 20px 16px;">',
        '<h1 style="margin:0 0 4px;font-size:20px;line-height:1.3;color:{};">{}</h1>'.format(
            '#dc2626' if cancelled else '#111827', e(headline)
        ),
        '<p style="margin:0 0 16px;color:#3d4452;">{}</p>'.format(e(intro)),
        '<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">',
    ]
    for label, value, href in rows:
        shown = '<a href="{}" style="color:#4338ca;">{}</a>'.format(e(href), e(value)) if href else e(value)
        out.append(
            '<tr><td style="padding:4px 16px 4px 0;color:#6b7280;vertical-align:top;white-space:nowrap;">{}</td>'
            '<td style="padding:4px 0;word-break:break-word;">{}</td></tr>'.format(e(label), shown)
        )
    out.append('</table>')
    if change_lines:
        out.append('<h2 style="margin:20px 0 4px;font-size:15px;">What changed</h2>')
        out.append('<ul style="margin:0;padding-left:20px;">')
        out += ['<li style="margin:2px 0;word-break:break-word;">{}</li>'.format(e(line)) for line in change_lines]
        out.append('</ul>')
    out += ['<p style="margin:16px 0 0;color:#3d4452;">{}</p>'.format(e(note)) for note in notes]
    if site:
        out.append(
            '<p style="margin:20px 0 4px;"><a href="{}" style="display:inline-block;background:#4f46e5;'
            'color:#ffffff;text-decoration:none;font-weight:600;padding:9px 16px;border-radius:8px;">'
            'Open Dayplan</a></p>'.format(e(site))
        )
    out += [
        '</div>',
        '<p style="margin:16px 4px 0;font-size:12px;line-height:1.5;color:#6b7280;">{}</p>'.format(e(FOOTER)),
        '</div></body></html>',
    ]
    return '\n'.join(out) + '\n'


def compose(meeting, kind, *, recipient, site_url, config, recipient_zone='', changes=(), previous=None,
            sequence=0, now=None):
    """The email about a meeting for one recipient.

    meeting: the meeting as saved (or a snapshot of it; for 'cancelled' the
    last one emailed). kind: one of KINDS. recipient: their email address
    (ValueError if it isn't a valid one). recipient_zone: their IANA time
    zone, or '' (then no 'Your time' line). site_url: the address of Dayplan.
    For 'changed': changes lists the changed NOTIFY_FIELDS and previous is
    the snapshot the last email was about (to show what it said before);
    without changes they are worked out from previous. sequence: the
    calendar file's SEQUENCE, one higher for each update. now: the time the
    email is written (UTC; default now).

    Every kind but 'cancelled' carries a calendar file (.ics) when the
    meeting has a date. The subject of a change ends in "now <new start>"
    when the start moved.
    """
    if kind not in KINDS:
        raise ValueError('Unknown kind of email: {}'.format(kind))
    now = _utc(now)
    snap = snapshot(meeting)
    before = snapshot(previous) if isinstance(previous, dict) else None
    times = _times(snap)
    title = _title(snap)
    company = _one_line(snap['company'], COMPANY_MAX)
    meeting_url = clean_url(snap['meetingUrl'])
    job_url = clean_url(snap['jobUrl'])
    site = clean_url(site_url)
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
        sequence = 0

    change_lines = []
    moved = False
    if kind == 'changed':
        wanted = set(changes or ())
        if not wanted and before is not None:
            wanted = set(changed_fields(before, snap))
        change_lines = _change_lines(wanted, before, snap, times)
        moved = bool(wanted & {'dueDate', 'dueTime', 'timeZone'})

    name = company or _one_line(snap['title'], 80) or 'Meeting'
    subject = '{}: {}'.format(SUBJECTS[kind], _one_line(name, 80))
    short = _short_when(times)
    if short:
        subject += ' · {}{}'.format('now ' if moved else '', short)

    headline = HEADLINES[kind].format(title)
    rows = [('When', _when(times), '')]
    your_time = _your_time(times, recipient_zone)
    if your_time:
        rows.append(('Your time', your_time, ''))
    if company:
        rows.append(('Company', company, ''))
    if '{}' not in HEADLINES[kind]:
        rows.append(('Title', title, ''))
    if kind != 'cancelled':
        if meeting_url:
            rows.append(('Join link', meeting_url, meeting_url))
        if job_url:
            rows.append(('Job description', job_url, job_url))
        documents = _documents(snap)
        if documents:
            rows.append(('Documents', documents, ''))

    calendar = kind != 'cancelled' and times.day is not None
    notes = []
    if calendar:
        notes.append('Open the attached calendar file (.ics) to {} your calendar.'.format(
            'update this meeting in' if kind == 'changed' else 'add this meeting to'
        ))

    text = [headline, INTROS[kind], '']
    text += ['{}: {}'.format(label, value) for label, value, _ in rows]
    if change_lines:
        text += ['', 'What changed:'] + ['- ' + line for line in change_lines]
    for note in notes:
        text += ['', note]
    if site:
        text += ['', 'Open Dayplan: ' + site]
    text += ['', '-- ', FOOTER]

    msg = _message(config, recipient, subject, now)
    msg.set_content('\n'.join(text) + '\n', cte='quoted-printable')
    msg.add_alternative(
        _html(headline, INTROS[kind], rows, change_lines, notes, site, kind == 'cancelled'),
        subtype='html', cte='quoted-printable',
    )
    if calendar:
        ics = _ics(snap, times, title, company, meeting_url, job_url, sequence, now)
        # Added as bytes, so its CRLF line endings arrive exactly as written.
        msg.add_attachment(
            ics.encode('utf-8'), maintype='text', subtype='calendar',
            filename=_ics_file_name(title, snap['dueDate']), params={'method': 'PUBLISH', 'charset': 'utf-8'},
        )
    return msg


def test_message(config, recipient, site_url=''):
    """A short email that shows email from Dayplan works."""
    config = _config(config)
    if config is None:
        raise MailError(NOT_SET_UP)
    site = clean_url(site_url)
    lines = [
        'This is a test email from Dayplan. If you can read it, emails from Dayplan work.',
        '',
        'Approved accounts that ask for them get an email when a meeting is added, changed or cancelled.',
        'They are sent from {} through {}.'.format(_one_line(config['username']), _one_line(config['host'])),
    ]
    if site:
        lines += ['', 'Open Dayplan: ' + site]
    msg = _message(config, recipient, 'Dayplan email test', _utc(None))
    msg.set_content('\n'.join(lines) + '\n', cte='quoted-printable')
    return msg


# ------------------------------------------------------------------- sending

def _failure(stage, error, config):
    """A MailError for the admin, from what went wrong at which stage. It never
    repeats the server's own words (or anything else that could hold the password)."""
    host = _one_line(str(config.get('host') or DEFAULT_HOST), 100)
    port = config.get('port') or DEFAULT_PORT
    if isinstance(error, smtplib.SMTPAuthenticationError):
        return MailError(
            '{} did not accept the email address and password. Dayplan needs a Gmail app password, '
            'not the normal Gmail password: turn on 2-Step Verification for the Google account, create an '
            'app password at https://myaccount.google.com/apppasswords, then run {} in a PythonAnywhere '
            'console to save it.'.format(host, SETUP_COMMAND)
        )
    if isinstance(error, (socket.timeout, TimeoutError)):
        return MailError('The email server {} did not answer in time. Please try again in a few minutes.'.format(host))
    if stage == 'connect':
        return MailError(
            'Could not connect to the email server {} (port {}). Please try again in a few minutes. '
            '(A free PythonAnywhere account can only send email through smtp.gmail.com, port 587.)'.format(host, port)
        )
    if stage == 'tls':
        return MailError(
            'Could not set up a secure connection with the email server {}. '
            'Check that the port is 587, or try again later.'.format(host)
        )
    if stage == 'login':
        if isinstance(error, UnicodeError):
            return MailError(
                'The email address or password has characters the email server does not accept. '
                'Run {} to save them again.'.format(SETUP_COMMAND)
            )
        return MailError('Could not sign in to the email server {}. Run {} to check the settings.'.format(
            host, SETUP_COMMAND
        ))
    return MailError('The email server {} closed the connection. Please try again in a few minutes.'.format(host))


def send(config, messages, timeout=20):
    """Sends the emails over one connection. Returns {'sent': [...], 'failed': [...]}
    with each email's recipient (its To address).

    Raises MailError when nothing could be sent: no settings, no connection,
    no secure connection, a refused sign-in, or no answer in time. A server
    that refuses one email (a bad address, say) only fails that one; if the
    connection breaks halfway, the rest fail. Without any messages, nothing
    connects at all.
    """
    messages = list(messages)
    result = {'sent': [], 'failed': []}
    if not messages:
        return result
    config = _config(config)
    if config is None:
        raise MailError(NOT_SET_UP)
    stage = 'connect'
    finished = False
    try:
        with smtplib.SMTP(config['host'], config['port'], timeout=timeout) as smtp:
            stage = 'tls'
            smtp.ehlo()
            smtp.starttls(context=ssl.create_default_context())
            smtp.ehlo()
            stage = 'login'
            smtp.login(config['username'], config['password'])
            stage = 'send'
            for index, msg in enumerate(messages):
                recipient = str(msg['To'] or '')
                try:
                    smtp.send_message(msg)
                except (
                    smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPDataError,
                    smtplib.SMTPNotSupportedError, ValueError,
                ):
                    result['failed'].append(recipient)  # only this one was refused: carry on
                except OSError:  # smtplib's other errors are OSErrors too
                    # The connection broke (or timed out): the rest can't go now.
                    result['failed'] += [str(rest['To'] or '') for rest in messages[index:]]
                    break
                else:
                    result['sent'].append(recipient)
            finished = True
    except (OSError, ValueError) as error:  # socket, TLS and smtplib errors are all OSErrors
        if not finished:
            raise _failure(stage, error, config) from None
        # Everything was handed over; only saying goodbye failed.
    return result
