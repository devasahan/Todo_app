"""Tests for dayplan_mail.py. Run with: python3 -m unittest discover -s tests"""
import email
import email.errors
import email.policy
import json
import os
import random
import re
import shutil
import smtplib
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import dayplan_mail  # noqa: E402
from dayplan_mail import MailError  # noqa: E402

NOW = datetime(2026, 10, 16, 9, 0, tzinfo=timezone.utc)
SITE = 'https://dayplan.pythonanywhere.com/'
PASSWORD = 'abcdwxyzefghstuv'
CONFIG = {'username': 'planner@gmail.com', 'password': PASSWORD}
RESUME = {'id': 'a' * 32, 'name': 'resume.pdf', 'size': 1200}
LETTER = {'id': 'b' * 32, 'name': 'cover letter.pdf', 'size': 900}
# zoneinfo and its time zone data (Python 3.9+; most systems have the data).
HAS_ZONES = dayplan_mail.ZoneInfo is not None and dayplan_mail.valid_zone('America/New_York')
needs_zones = unittest.skipUnless(HAS_ZONES, 'needs zoneinfo and time zone data')


def meeting(**fields):
    """A meeting as the app saves it: Thu, Oct 22, 2026, 2-3 PM in New York."""
    plan = {
        'id': 'meeting-1',
        'kind': 'meeting',
        'title': 'Interview with Acme',
        'company': 'Acme',
        'description': 'Private notes: ask about salary',
        'dueDate': '2026-10-22',
        'dueTime': '14:00',
        'endTime': '15:00',
        'timeZone': 'America/New_York',
        'meetingUrl': 'https://zoom.us/j/123',
        'jobUrl': 'https://example.com/jobs/1',
        'resume': None,
        'coverLetter': None,
        'tags': ['secret-tag'],
        'checklist': [{'id': 'c1', 'text': 'Private step', 'done': False}],
        'status': 'todo',
        'priority': 'high',
    }
    plan.update(fields)
    return plan


def compose(plan, kind='new', **options):
    options.setdefault('recipient', 'viewer@example.com')
    options.setdefault('site_url', SITE)
    options.setdefault('config', CONFIG)
    options.setdefault('now', NOW)
    return dayplan_mail.compose(plan, kind, **options)


def plain(msg):
    return msg.get_body(('plain',)).get_content()


def html_of(msg):
    return msg.get_body(('html',)).get_content()


def calendar_part(msg):
    parts = [part for part in msg.iter_attachments() if part.get_content_type() == 'text/calendar']
    return parts[0] if parts else None


def ics_of(msg):
    """The calendar file exactly as attached (CRLF line endings, folded)."""
    part = calendar_part(msg)
    return part.get_payload(decode=True).decode('utf-8') if part else None


def unfolded(ics):
    return ics.replace('\r\n ', '').split('\r\n')


def parsed(msg):
    """The email as a mail server would read it."""
    return email.message_from_bytes(msg.as_bytes(policy=email.policy.SMTP), policy=email.policy.default)


class ScriptedSMTP(smtplib.SMTP):
    """The real smtplib.SMTP, so send_message, sendmail and their handling of
    each reply run just as they do with Gmail, with the network replaced by
    scripted replies. replies: {'mail' | 'rcpt' | 'data': {n: reply}} for the
    n-th email (from 0), where a reply is (code, text) or an exception to
    raise; anything not scripted is 250 OK."""

    def __init__(self, replies=None):
        super().__init__()  # no host, so it doesn't connect
        self.replies = replies or {}
        self.envelopes = []  # [sender, [recipients]] for each email begun
        self.delivered = []  # ([recipients], the email as written) for each email taken
        self.closed = False

    def ehlo(self, name=''):
        self.ehlo_resp = b'smtp.test'
        self.does_esmtp = True
        self.esmtp_features = {'smtputf8': '', '8bitmime': ''}
        return 250, b'smtp.test'

    def starttls(self, *args, **kwargs):
        return 220, b'2.0.0 Ready to start TLS'

    def login(self, user, password, **kwargs):
        return 235, b'2.7.0 Accepted'

    def _reply(self, step):
        reply = self.replies.get(step, {}).get(len(self.envelopes) - 1, (250, b'2.0.0 OK'))
        if isinstance(reply, BaseException):
            raise reply
        return reply

    def mail(self, sender, options=()):
        self.envelopes.append([sender, []])
        return self._reply('mail')

    def rcpt(self, recipient, options=()):
        self.envelopes[-1][1].append(recipient)
        return self._reply('rcpt')

    def data(self, msg):
        reply = self._reply('data')
        if reply[0] == 250:
            self.delivered.append((list(self.envelopes[-1][1]), msg))
        return reply

    def rset(self):
        return 250, b'2.1.5 Flushed'

    def close(self):
        self.closed = True
        super().close()


def scripted(replies=None):
    """A stand-in for smtplib.SMTP that makes ScriptedSMTP connections, and the list of them."""
    servers = []

    def connect(host, port, timeout=None):
        servers.append(ScriptedSMTP(replies))
        return servers[-1]

    return connect, servers


def written(msg):
    """(envelope recipients, the email read back) as smtplib would send `msg` to its checked address."""
    server = ScriptedSMTP()
    server.ehlo()
    server.send_message(msg, to_addrs=[dayplan_mail._header_address(msg)])
    recipients, raw = server.delivered[0]
    return recipients, email.message_from_string(raw.decode('utf-8'), policy=email.policy.default)


# ------------------------------------------------------------------ settings

class Config(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / 'private' / 'email.json'

    def test_save_and_load_fill_in_defaults(self):
        dayplan_mail.save_config(self.path, {'username': ' planner@gmail.com ', 'password': PASSWORD})
        self.assertEqual(dayplan_mail.load_config(self.path), {
            'host': 'smtp.gmail.com', 'port': 587, 'username': 'planner@gmail.com',
            'password': PASSWORD, 'from_name': 'Dayplan',
        })
        self.assertEqual(dayplan_mail.DEFAULT_HOST, 'smtp.gmail.com')
        self.assertEqual(dayplan_mail.DEFAULT_PORT, 587)

    def test_keeps_its_own_settings(self):
        config = {'host': 'smtp.example.com', 'port': 2525, 'username': 'a@example.com', 'password': 'pw',
                  'from_name': 'Interview schedule'}
        dayplan_mail.save_config(self.path, config)
        self.assertEqual(dayplan_mail.load_config(self.path), config)

    def test_only_the_owner_can_read_the_file(self):
        old = os.umask(0)  # even with a umask that would let everyone read it
        try:
            dayplan_mail.save_config(self.path, CONFIG)
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o700)

    def test_replaces_the_file_in_one_step(self):
        dayplan_mail.save_config(self.path, CONFIG)
        with mock.patch('dayplan_mail.os.replace', wraps=os.replace) as replace:
            dayplan_mail.save_config(self.path, dict(CONFIG, password='new-password'))
        temp, target = replace.call_args[0]
        self.assertEqual(Path(temp).parent, self.path.parent)
        self.assertEqual(Path(target), self.path)
        self.assertEqual(dayplan_mail.load_config(self.path)['password'], 'new-password')
        self.assertEqual(os.listdir(str(self.path.parent)), ['email.json'])  # no temporary file left behind
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_a_failed_save_keeps_the_old_file(self):
        dayplan_mail.save_config(self.path, CONFIG)
        with mock.patch('dayplan_mail.json.dump', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                dayplan_mail.save_config(self.path, dict(CONFIG, password='new-password'))
        self.assertEqual(dayplan_mail.load_config(self.path)['password'], PASSWORD)
        self.assertEqual(os.listdir(str(self.path.parent)), ['email.json'])

    def test_needs_a_username_and_password(self):
        with self.assertRaises(ValueError):
            dayplan_mail.save_config(self.path, {'username': 'a@example.com'})
        self.assertFalse(self.path.exists())

    def test_missing_or_broken_files_load_as_none(self):
        self.assertIsNone(dayplan_mail.load_config(self.path))
        self.path.parent.mkdir()
        for content in (b'not json', b'[1, 2]', b'{"username": "a@example.com"}', b'{"password": "pw"}',
                        b'{"username": "", "password": "pw"}', b'{"username": 5, "password": "pw"}', b'\xff\xfe\x00'):
            self.path.write_bytes(content)
            self.assertIsNone(dayplan_mail.load_config(self.path), content)
        self.assertIsNone(dayplan_mail.load_config(self.dir.name))  # a folder, not a file

    def test_a_bad_port_falls_back_to_587(self):
        self.path.parent.mkdir()
        for port, expected in ((0, 587), (70000, 587), ('465', 465), (True, 587), ('x', 587)):
            self.path.write_text(json.dumps(dict(CONFIG, port=port)))
            self.assertEqual(dayplan_mail.load_config(self.path)['port'], expected, port)

    def test_delete(self):
        self.assertFalse(dayplan_mail.delete_config(self.path))
        dayplan_mail.save_config(self.path, CONFIG)
        self.assertTrue(dayplan_mail.delete_config(self.path))
        self.assertFalse(self.path.exists())
        self.assertIsNone(dayplan_mail.load_config(self.path))


# ---------------------------------------------------------------- time zones

class TimeZones(unittest.TestCase):
    @needs_zones
    def test_known_zones(self):
        for name in ('America/New_York', 'UTC', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'Etc/GMT+3',
                     'America/Port-au-Prince'):
            self.assertTrue(dayplan_mail.valid_zone(name), name)

    def test_not_zones(self):
        for name in ('', None, 5, ['UTC'], 'A' * 65, '../etc/passwd', '/etc/passwd', 'America/../UTC',
                     'posixrules', 'localtime', 'america/new_york', 'UTC\n', 'Europe/Berlin ', 'Europe\\Berlin'):
            self.assertFalse(dayplan_mail.valid_zone(name), name)

    @needs_zones
    def test_unknown_zones(self):
        for name in ('Not/A_Zone', 'Mars/Base', 'America', 'Etc'):
            self.assertFalse(dayplan_mail.valid_zone(name), name)

    def test_without_zoneinfo_the_name_is_checked(self):
        with mock.patch.object(dayplan_mail, 'ZoneInfo', None):
            self.assertTrue(dayplan_mail.valid_zone('America/New_York'))
            self.assertTrue(dayplan_mail.valid_zone('UTC'))
            self.assertTrue(dayplan_mail.valid_zone('Asia/Calcutta'))
            for name in ('', 'bad zone', '../x', '/UTC', 'A' * 65, 'x/y', 'UTC\n'):
                self.assertFalse(dayplan_mail.valid_zone(name), name)

    # The old names Chrome, Edge and Node report (Intl.supportedValuesOf('timeZone')
    # with ICU 74-77) that a server without the tz "backward" links can't load.
    BROWSER_OLD_NAMES = (
        'Africa/Asmera', 'America/Buenos_Aires', 'America/Catamarca', 'America/Cordoba', 'America/Godthab',
        'America/Indianapolis', 'America/Jujuy', 'America/Louisville', 'America/Mendoza', 'Asia/Calcutta',
        'Asia/Katmandu', 'Asia/Rangoon', 'Asia/Saigon', 'Atlantic/Faeroe', 'Europe/Kiev', 'Pacific/Enderbury',
        'Pacific/Ponape', 'Pacific/Truk',
    )

    def test_every_old_browser_name_has_a_current_one(self):
        for name in self.BROWSER_OLD_NAMES:
            self.assertIn(name, dayplan_mail.ZONE_ALIASES, name)
        for old, new in dayplan_mail.ZONE_ALIASES.items():
            self.assertNotEqual(old, new)
            self.assertTrue(dayplan_mail.ZONE_RE.fullmatch(old) and dayplan_mail.ZONE_RE.fullmatch(new), old)

    @needs_zones
    def test_old_names_browsers_use(self):
        moments = [datetime(2026, month, 15, 12, tzinfo=timezone.utc) for month in (1, 4, 7, 10)]
        for old, new in dayplan_mail.ZONE_ALIASES.items():
            self.assertTrue(dayplan_mail.valid_zone(old), old)
            self.assertTrue(dayplan_mail.valid_zone(new), new)
            try:
                current = dayplan_mail.ZoneInfo(new)
            except KeyError:  # time zone data older than the current name
                continue
            for moment in moments:  # the old name shows the same clocks as the current one
                self.assertEqual(
                    moment.astimezone(dayplan_mail._tz(old)).utcoffset(), moment.astimezone(current).utcoffset(), old,
                )

    @needs_zones
    def test_old_names_on_a_server_without_them(self):
        from zoneinfo import ZoneInfoNotFoundError
        real = dayplan_mail.ZoneInfo

        def without_old_names(name):
            if name in dayplan_mail.ZONE_ALIASES:
                raise ZoneInfoNotFoundError(name)
            return real(name)

        with mock.patch.object(dayplan_mail, 'ZoneInfo', without_old_names):
            for old, new in dayplan_mail.ZONE_ALIASES.items():
                self.assertTrue(dayplan_mail.valid_zone(old), old)
                self.assertEqual(dayplan_mail._tz(old).key, new, old)
            self.assertFalse(dayplan_mail.valid_zone('Mars/Base'))
            msg = compose(meeting(timeZone='Asia/Calcutta', dueTime='10:00', endTime='11:00'), recipient_zone='Europe/Kiev')
            text = plain(msg)
            self.assertIn('When: Thu, Oct 22, 2026, 10:00 – 11:00 AM IST (Kolkata time)\n', text)
            self.assertIn('Your time: Thu, Oct 22, 7:30 – 8:30 AM EEST\n', text)
            self.assertIn('DTSTART:20261022T043000Z', unfolded(ics_of(msg)))

    @needs_zones
    def test_current_names_on_a_server_with_older_data(self):
        from zoneinfo import ZoneInfoNotFoundError
        real = dayplan_mail.ZoneInfo
        current = set(dayplan_mail.ZONE_ALIASES.values())

        def only_old_names(name):
            if name in current:
                raise ZoneInfoNotFoundError(name)
            # Stands in for the old name's own file, which this machine may not have.
            return real(dayplan_mail.ZONE_ALIASES.get(name, name))

        with mock.patch.object(dayplan_mail, 'ZoneInfo', only_old_names):
            for new in current:
                self.assertTrue(dayplan_mail.valid_zone(new), new)
            self.assertIn('(Kyiv time)', plain(compose(meeting(timeZone='Europe/Kyiv'))))

    @needs_zones
    @unittest.skipUnless(shutil.which('node'), 'needs Node.js')
    def test_every_zone_a_browser_lists(self):
        try:
            out = subprocess.run(
                ['node', '-e', "console.log(Intl.supportedValuesOf('timeZone').join(' '))"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            self.skipTest('Node.js did not run')
        names = out.stdout.split()
        if out.returncode or not names:
            self.skipTest('this Node.js cannot list its time zones')
        self.assertEqual([name for name in names if not dayplan_mail.valid_zone(name)], [])

    @needs_zones
    def test_emails_in_old_zones(self):
        msg = compose(meeting(timeZone='Asia/Calcutta', dueTime='10:00', endTime='11:00'), recipient_zone='Europe/Kiev')
        text = plain(msg)
        self.assertIn('When: Thu, Oct 22, 2026, 10:00 – 11:00 AM IST (Kolkata time)\n', text)
        self.assertIn('Your time: Thu, Oct 22, 7:30 – 8:30 AM EEST\n', text)
        self.assertEqual(msg['Subject'], 'New meeting: Acme · Thu, Oct 22, 10:00 AM IST')
        self.assertIn('DTSTART:20261022T043000Z', unfolded(ics_of(msg)))
        self.assertIn('(Buenos Aires time)', plain(compose(meeting(timeZone='America/Buenos_Aires'))))
        self.assertIn('(Indianapolis time)', plain(compose(meeting(timeZone='America/Indianapolis'))))
        # The city as the app's time zone menu shows it (RENAMED_CITIES in js/core.js).
        self.assertEqual(dayplan_mail._city('Asia/Saigon'), 'Ho Chi Minh')
        self.assertEqual(dayplan_mail._city('Pacific/Truk'), 'Truk')


# ----------------------------------------------------------------- snapshots

class Snapshots(unittest.TestCase):
    def test_only_the_key_fields(self):
        snap = dayplan_mail.snapshot(meeting(title='  Interview with Acme  ', resume=RESUME))
        self.assertEqual(sorted(snap), sorted(('id', 'kind') + dayplan_mail.NOTIFY_FIELDS))
        self.assertEqual(snap['title'], 'Interview with Acme')
        self.assertEqual(snap['resume'], {'id': 'a' * 32, 'name': 'resume.pdf'})
        self.assertIsNone(snap['coverLetter'])
        self.assertNotIn('description', snap)
        self.assertNotIn('checklist', snap)
        self.assertEqual(json.loads(json.dumps(snap)), snap)
        self.assertEqual(dayplan_mail.snapshot(snap), snap)

    def test_missing_fields(self):
        snap = dayplan_mail.snapshot({'id': 'x'})
        self.assertEqual(snap['dueTime'], '')
        self.assertEqual(snap['timeZone'], '')
        self.assertIsNone(snap['resume'])
        self.assertEqual(dayplan_mail.snapshot(None)['id'], '')
        self.assertIsNone(dayplan_mail.snapshot({'resume': {'name': 'no id.pdf'}})['resume'])

    def test_changed_fields(self):
        before = meeting(resume=RESUME)
        self.assertEqual(dayplan_mail.changed_fields(before, meeting(resume=RESUME)), [])
        after = meeting(dueTime='15:00', endTime='16:00', company='Globex', resume=LETTER, coverLetter=LETTER,
                        meetingUrl='https://zoom.us/j/999', description='other notes', tags=[])
        self.assertEqual(
            dayplan_mail.changed_fields(before, after),
            ['company', 'dueTime', 'endTime', 'meetingUrl', 'resume', 'coverLetter'],
        )

    def test_what_does_not_count_as_a_change(self):
        before = meeting(resume=RESUME)
        same = meeting(
            title=' Interview with Acme\n', meetingUrl='zoom.us/j/123', jobUrl='HTTPS://EXAMPLE.COM/jobs/1',
            resume=dict(RESUME, name='renamed.pdf', size=1), status='done', checklist=[],
        )
        self.assertEqual(dayplan_mail.changed_fields(before, same), [])
        self.assertEqual(dayplan_mail.changed_fields(dayplan_mail.snapshot(before), same), [])

    def test_time_zone_of_a_date_only_meeting(self):
        # As notifyChanges in js/core.js: the zone counts only when dueTime is set on either side.
        before = meeting(dueTime='', endTime='', timeZone='America/New_York')
        for zone in ('Europe/Paris', '', 'Not/A_Zone'):
            self.assertEqual(dayplan_mail.changed_fields(before, meeting(dueTime='', endTime='', timeZone=zone)), [])
        self.assertEqual(dayplan_mail.changed_fields(before, meeting(dueTime='  ', endTime='', timeZone='UTC')), [])
        self.assertEqual(
            dayplan_mail.changed_fields(before, meeting(dueDate='2026-10-23', dueTime='', endTime='', timeZone='UTC')),
            ['dueDate'],
        )
        self.assertEqual(dayplan_mail.changed_fields(before, meeting(timeZone='Europe/Paris')),
                         ['dueTime', 'endTime', 'timeZone'])
        self.assertEqual(dayplan_mail.changed_fields(meeting(), meeting(dueTime='', endTime='', timeZone='')),
                         ['dueTime', 'endTime', 'timeZone'])
        self.assertEqual(dayplan_mail.changed_fields(meeting(), meeting(timeZone='Europe/Paris')), ['timeZone'])

    def test_documents_added_or_removed(self):
        self.assertEqual(dayplan_mail.changed_fields(meeting(), meeting(resume=RESUME)), ['resume'])
        self.assertEqual(dayplan_mail.changed_fields(meeting(coverLetter=LETTER), meeting()), ['coverLetter'])

    def test_links_are_compared_cleaned(self):
        self.assertEqual(dayplan_mail.changed_fields(meeting(meetingUrl='javascript:alert(1)'), meeting(meetingUrl='')), [])
        self.assertEqual(dayplan_mail.changed_fields(meeting(jobUrl=''), meeting(jobUrl='example.com/j')), ['jobUrl'])


class Links(unittest.TestCase):
    def test_like_the_app(self):
        cases = {
            'zoom.us/j/1': 'https://zoom.us/j/1',
            'HTTPS://Example.COM': 'https://example.com/',
            'http://example.com:80/a': 'http://example.com/a',
            'https://example.com:8443/x': 'https://example.com:8443/x',
            'https://example.com/a"b': 'https://example.com/a%22b',
            'https://example.com/?q=<x>': 'https://example.com/?q=%3Cx%3E',
            'https://bücher.de/straße': 'https://xn--bcher-kva.de/stra%C3%9Fe',
            'https://example.com/a/../b/./c': 'https://example.com/b/c',
            '  https://example.com/x  ': 'https://example.com/x',
        }
        for value, expected in cases.items():
            self.assertEqual(dayplan_mail.clean_url(value), expected, value)
            self.assertEqual(dayplan_mail.clean_url(expected), expected, expected)

    def test_refused(self):
        for value in ('javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'ftp://example.com',
                      'http://localhost:8000/', 'https://user:pw@example.com/', 'https://example.com/a b',
                      'https://example.com:99999/', 'mailto:a@example.com', '', None, 42, 'https://' + 'a' * 2000 + '.com',
                      'https://exa\nmple.com', 'vbscript:x'):
            self.assertEqual(dayplan_mail.clean_url(value), '', value)


# -------------------------------------------------------------------- emails

class Compose(unittest.TestCase):
    @needs_zones
    def test_new_meeting(self):
        msg = compose(meeting(resume=RESUME, coverLetter=LETTER))
        self.assertEqual(msg['Subject'], 'New meeting: Acme · Thu, Oct 22, 2:00 PM EDT')
        text = plain(msg)
        self.assertTrue(text.startswith('New meeting: Interview with Acme\n'))
        self.assertIn('When: Thu, Oct 22, 2026, 2:00 – 3:00 PM EDT (New York time)\n', text)
        self.assertIn('Company: Acme\n', text)
        self.assertIn('Join link: https://zoom.us/j/123\n', text)
        self.assertIn('Job description: https://example.com/jobs/1\n', text)
        self.assertIn('Documents: Resume and cover letter are in Dayplan.\n', text)
        self.assertIn('Open Dayplan: ' + SITE, text)
        self.assertIn('turn off “Email me about meeting changes”.', text)
        self.assertNotIn('Title:', text)  # already in the headline
        self.assertNotIn('Your time', text)
        self.assertNotIn('What changed', text)
        page = html_of(msg)
        self.assertIn('2:00 – 3:00 PM EDT (New York time)', page)
        self.assertIn('<a href="https://zoom.us/j/123"', page)
        self.assertIn('<a href="{}"'.format(SITE), page)

    def test_private_parts_stay_in_dayplan(self):
        msg = compose(meeting(resume=RESUME, coverLetter=LETTER))
        raw = msg.as_string() + plain(msg) + html_of(msg) + ics_of(msg)
        for private in ('Private notes', 'Private step', 'secret-tag', 'resume.pdf', 'cover letter.pdf', PASSWORD):
            self.assertNotIn(private, raw)
        self.assertEqual([part.get_content_type() for part in msg.iter_attachments()], ['text/calendar'])

    def test_headers(self):
        msg = compose(meeting(), config=dict(CONFIG, from_name='Interview schedule'))
        self.assertEqual(msg['From'], 'Interview schedule <planner@gmail.com>')
        self.assertEqual(msg['To'], 'viewer@example.com')
        self.assertEqual(msg['Date'].datetime, NOW)
        self.assertTrue(msg['Message-ID'].endswith('@dayplan>'))
        self.assertEqual(msg['Auto-Submitted'], 'auto-generated')
        self.assertEqual(msg.get_content_type(), 'multipart/mixed')
        self.assertEqual(msg.get_payload(0).get_content_type(), 'multipart/alternative')
        self.assertNotEqual(compose(meeting())['Message-ID'], msg['Message-ID'])

    @needs_zones
    def test_calendar_file(self):
        msg = compose(meeting(), sequence=3)
        part = calendar_part(msg)
        self.assertEqual(part.get_content_type(), 'text/calendar')
        self.assertEqual(part.get_param('method'), 'PUBLISH')
        self.assertEqual(part.get_param('charset'), 'utf-8')
        self.assertEqual(part.get_filename(), 'interview-with-acme-2026-10-22.ics')
        ics = ics_of(msg)
        self.assertTrue(ics.endswith('\r\n'))
        self.assertNotIn('\n', ics.replace('\r\n', ''))  # CRLF only
        lines = unfolded(ics)
        for line in ('BEGIN:VCALENDAR', 'METHOD:PUBLISH', 'UID:meeting-1@dayplan', 'DTSTAMP:20261016T090000Z',
                     'SEQUENCE:3', 'DTSTART:20261022T180000Z', 'DTEND:20261022T190000Z', 'SUMMARY:Interview with Acme',
                     'LOCATION:https://zoom.us/j/123', 'URL:https://zoom.us/j/123', 'TRIGGER:-PT15M', 'END:VCALENDAR'):
            self.assertIn(line, lines)
        description = [line for line in lines if line.startswith('DESCRIPTION:Company')][0]
        self.assertEqual(
            description,
            'DESCRIPTION:Company: Acme\\nMeeting link: https://zoom.us/j/123\\n'
            'Job description: https://example.com/jobs/1\\nTime zone: New York (EDT)',
        )

    @needs_zones
    def test_without_an_end_time_it_lasts_an_hour(self):
        for end in ('', '13:00', '14:00', 'soon'):
            msg = compose(meeting(endTime=end))
            self.assertIn('When: Thu, Oct 22, 2026, 2:00 PM EDT (New York time)\n', plain(msg))
            self.assertIn('DTEND:20261022T190000Z', unfolded(ics_of(msg)))

    @needs_zones
    def test_morning_to_afternoon(self):
        msg = compose(meeting(dueTime='11:30', endTime='12:30'))
        self.assertIn('When: Thu, Oct 22, 2026, 11:30 AM – 12:30 PM EDT (New York time)', plain(msg))
        msg = compose(meeting(dueTime='00:05', endTime='00:45'))
        self.assertIn('12:05 – 12:45 AM EDT', plain(msg))

    @needs_zones
    def test_your_time(self):
        msg = compose(meeting(), recipient_zone='Europe/Berlin')
        self.assertIn('\nYour time: Thu, Oct 22, 8:00 – 9:00 PM CEST\n', plain(msg))
        self.assertIn('8:00 – 9:00 PM CEST', html_of(msg))

    @needs_zones
    def test_your_time_after_the_clocks_change(self):
        # Europe goes back to winter time on Oct 25, 2026; New York only on Nov 1.
        msg = compose(meeting(dueDate='2026-10-28'), recipient_zone='Europe/Berlin')
        self.assertIn('Your time: Wed, Oct 28, 7:00 – 8:00 PM CET\n', plain(msg))
        msg = compose(meeting(dueDate='2026-11-04'), recipient_zone='Europe/Berlin')
        self.assertIn('When: Wed, Nov 4, 2026, 2:00 – 3:00 PM EST (New York time)', plain(msg))
        self.assertIn('Your time: Wed, Nov 4, 8:00 – 9:00 PM CET\n', plain(msg))

    @needs_zones
    def test_your_time_past_midnight(self):
        msg = compose(meeting(dueTime='17:30', endTime='18:30'), recipient_zone='Europe/Berlin')
        self.assertIn('Your time: Thu, Oct 22, 11:30 PM – Fri, Oct 23, 12:30 AM CEST\n', plain(msg))
        msg = compose(meeting(dueTime='17:30', endTime=''), recipient_zone='Asia/Tokyo')
        self.assertIn('Your time: Fri, Oct 23, 6:30 AM JST\n', plain(msg))

    @needs_zones
    def test_no_your_time_when_the_clocks_agree(self):
        for zone in ('America/Toronto', 'America/New_York', '', 'Not/A_Zone', None):
            self.assertNotIn('Your time', plain(compose(meeting(), recipient_zone=zone)), zone)
        # Same offset, other name: London and UTC in winter.
        msg = compose(meeting(dueDate='2026-12-01', timeZone='UTC'), recipient_zone='Europe/London')
        self.assertNotIn('Your time', plain(msg))
        self.assertIn('When: Tue, Dec 1, 2026, 2:00 – 3:00 PM UTC\n', plain(msg))

    @needs_zones
    def test_zones_known_by_their_offset(self):
        self.assertTrue(compose(meeting(timeZone='Asia/Riyadh'))['Subject'].endswith('Thu, Oct 22, 2:00 PM GMT+3'))
        self.assertTrue(compose(meeting(timeZone='Asia/Kathmandu'))['Subject'].endswith('2:00 PM GMT+5:45'))
        self.assertTrue(compose(meeting(timeZone='America/Sao_Paulo'))['Subject'].endswith('2:00 PM GMT-3'))
        self.assertEqual(dayplan_mail._city('Asia/Calcutta'), 'Kolkata')  # an old name, as in the app
        self.assertIn('(Buenos Aires time)', plain(compose(meeting(timeZone='America/Argentina/Buenos_Aires'))))
        msg = compose(meeting(dueTime='09:00', endTime='10:00'), recipient_zone='America/St_Johns')
        self.assertIn('Your time: Thu, Oct 22, 10:30 – 11:30 AM NDT', plain(msg))

    @needs_zones
    def test_a_time_the_clocks_skip(self):
        # Clocks in New York jump from 2:00 to 3:00 AM on Mar 8, 2026: 2:30 is 3:30, as in the app.
        msg = compose(meeting(dueDate='2026-03-08', dueTime='02:30', endTime='04:00'))
        self.assertIn('When: Sun, Mar 8, 2026, 3:30 – 4:00 AM EDT (New York time)', plain(msg))
        self.assertIn('DTSTART:20260308T073000Z', unfolded(ics_of(msg)))

    def test_floating_time(self):
        zones = ('', 'not a zone', None) + (('Mars/Base',) if HAS_ZONES else ())
        for zone in zones:
            msg = compose(meeting(timeZone=zone), recipient_zone='Europe/Berlin')
            text = plain(msg)
            self.assertIn('When: Thu, Oct 22, 2026, 2:00 – 3:00 PM (local time)\n', text)
            self.assertNotIn('Your time', text)
            self.assertEqual(msg['Subject'], 'New meeting: Acme · Thu, Oct 22, 2:00 PM')
            lines = unfolded(ics_of(msg))
            self.assertIn('DTSTART:20261022T140000', lines)
            self.assertIn('DTEND:20261022T150000', lines)
            self.assertFalse([line for line in lines if line.startswith('DTSTART') and line.endswith('Z')])
            self.assertFalse([line for line in lines if line.startswith('DESCRIPTION:') and 'Time zone' in line])

    def test_date_only(self):
        msg = compose(meeting(dueTime='', endTime='16:00'), recipient_zone='Europe/Berlin')
        self.assertEqual(msg['Subject'], 'New meeting: Acme · Thu, Oct 22')
        self.assertIn('When: Thu, Oct 22, 2026\n', plain(msg))
        self.assertNotIn('Your time', plain(msg))
        lines = unfolded(ics_of(msg))
        self.assertIn('DTSTART;VALUE=DATE:20261022', lines)
        self.assertIn('DTEND;VALUE=DATE:20261023', lines)
        self.assertNotIn('BEGIN:VALARM', lines)

    def test_no_date(self):
        for day in ('', '2026-02-31', '22/10/2026', None):
            msg = compose(meeting(dueDate=day))
            self.assertEqual(msg['Subject'], 'New meeting: Acme')
            self.assertIn('When: No date set\n', plain(msg))
            self.assertIsNone(calendar_part(msg))
            self.assertNotIn('calendar file', plain(msg))

    def test_names_for_the_subject(self):
        self.assertTrue(compose(meeting(company=''))['Subject'].startswith('New meeting: Interview with Acme ·'))
        self.assertTrue(compose(meeting(company='', title=''))['Subject'].startswith('New meeting: Meeting ·'))
        msg = compose(meeting(company='', title=''))
        self.assertTrue(plain(msg).startswith('New meeting: Untitled meeting\n'))
        self.assertEqual(compose(meeting(title='', company='Globex'))['Subject'][:20], 'New meeting: Globex ')

    def test_long_subjects_are_cut(self):
        msg = compose(meeting(company='Acme ' * 60))
        self.assertLessEqual(len(msg['Subject']), 150)
        self.assertIn('…', msg['Subject'])

    @needs_zones
    def test_cancelled(self):
        last = dayplan_mail.snapshot(meeting(resume=RESUME))
        msg = compose(last, 'cancelled', recipient_zone='Europe/Berlin')
        self.assertEqual(msg['Subject'], 'Meeting cancelled: Acme · Thu, Oct 22, 2:00 PM EDT')
        text = plain(msg)
        self.assertTrue(text.startswith('This meeting was cancelled\n'))
        self.assertIn('When: Thu, Oct 22, 2026, 2:00 – 3:00 PM EDT (New York time)\n', text)
        self.assertIn('Your time: Thu, Oct 22, 8:00 – 9:00 PM CEST\n', text)
        self.assertIn('Title: Interview with Acme\n', text)
        self.assertIn('remove it there', text)
        self.assertNotIn('Join link', text)
        self.assertNotIn('Documents', text)
        self.assertIsNone(calendar_part(msg))
        self.assertEqual(msg.get_content_type(), 'multipart/alternative')

    @needs_zones
    def test_restored(self):
        msg = compose(meeting(), 'restored', sequence=4)
        self.assertEqual(msg['Subject'], 'Meeting back on: Acme · Thu, Oct 22, 2:00 PM EDT')
        self.assertTrue(plain(msg).startswith('This meeting is back on\n'))
        self.assertIn('Title: Interview with Acme\n', plain(msg))
        self.assertIn('SEQUENCE:4', unfolded(ics_of(msg)))

    @needs_zones
    def test_reminder(self):
        msg = compose(meeting(), 'reminder')
        self.assertEqual(msg['Subject'], 'Meeting details: Acme · Thu, Oct 22, 2:00 PM EDT')
        self.assertTrue(plain(msg).startswith('Meeting details: Interview with Acme\n'))
        self.assertIsNotNone(calendar_part(msg))

    def test_every_kind(self):
        for kind in dayplan_mail.KINDS:
            msg = compose(meeting(), kind)
            self.assertEqual(calendar_part(msg) is None, kind == 'cancelled', kind)
            parsed(msg)  # can be sent as it is
        with self.assertRaises(ValueError):
            compose(meeting(), 'deleted')

    @needs_zones
    def test_changed_time(self):
        before = dayplan_mail.snapshot(meeting(dueDate='2026-10-21', endTime=''))
        msg = compose(meeting(), 'changed', previous=before, changes=['dueDate', 'endTime'], sequence=1)
        self.assertEqual(msg['Subject'], 'Meeting changed: Acme · now Thu, Oct 22, 2:00 PM EDT')
        text = plain(msg)
        self.assertTrue(text.startswith('Meeting changed: Interview with Acme\n'))
        self.assertIn(
            '\nWhat changed:\n- When: was Wed, Oct 21, 2026, 2:00 PM EDT (New York time), '
            'now Thu, Oct 22, 2026, 2:00 – 3:00 PM EDT (New York time)\n', text,
        )
        self.assertEqual(text.count('- When:'), 1)  # the date and end time make one line
        self.assertIn('update this meeting in your calendar', text)
        self.assertIn('<h2', html_of(msg))
        self.assertIn('SEQUENCE:1', unfolded(ics_of(msg)))

    @needs_zones
    def test_changed_details(self):
        before = dayplan_mail.snapshot(meeting(
            company='Old Co', title='Old title', meetingUrl='', jobUrl='https://example.com/old',
            resume=RESUME, coverLetter=LETTER,
        ))
        after = meeting(resume=dict(RESUME, id='c' * 32), jobUrl='')
        msg = compose(after, 'changed', previous=before)  # the changes are worked out
        self.assertEqual(msg['Subject'], 'Meeting changed: Acme · Thu, Oct 22, 2:00 PM EDT')  # it didn't move
        changes = plain(msg).split('What changed:\n')[1].split('\n\n')[0].splitlines()
        self.assertEqual(changes, [
            '- Company: was Old Co, now Acme',
            '- Title: was Old title, now Interview with Acme',
            '- Meeting link: added https://zoom.us/j/123',
            '- Job description link: removed (was https://example.com/old)',
            '- Resume: replaced',
            '- Cover letter: removed',
        ])

    @needs_zones
    def test_changed_without_the_old_version(self):
        msg = compose(meeting(coverLetter=LETTER), 'changed', changes=['company', 'timeZone', 'coverLetter', 'tags'])
        text = plain(msg)
        self.assertIn('- When: now Thu, Oct 22, 2026, 2:00 – 3:00 PM EDT (New York time)\n', text)
        self.assertIn('- Company: now Acme\n', text)
        self.assertIn('- Cover letter: updated\n', text)
        self.assertIn('now Thu, Oct 22', msg['Subject'])

    @needs_zones
    def test_time_zone_change(self):
        before = dayplan_mail.snapshot(meeting(timeZone='America/Chicago'))
        msg = compose(meeting(), 'changed', previous=before)
        self.assertIn('- When: was Thu, Oct 22, 2026, 2:00 – 3:00 PM CDT (Chicago time), now', plain(msg))

    @needs_zones
    def test_time_zone_change_moves_the_start(self):
        before = dayplan_mail.snapshot(meeting())
        msg = compose(meeting(timeZone='America/Chicago'), 'changed', previous=before)
        self.assertEqual(msg['Subject'], 'Meeting changed: Acme · now Thu, Oct 22, 2:00 PM CDT')
        msg = compose(meeting(), 'changed', previous=dayplan_mail.snapshot(meeting(dueTime='', endTime='')))
        self.assertEqual(msg['Subject'], 'Meeting changed: Acme · now Thu, Oct 22, 2:00 PM EDT')

    @needs_zones
    def test_now_only_when_the_start_people_read_changed(self):
        before = dayplan_mail.snapshot(meeting())
        # Toronto keeps New York's clocks: the When line names the new city, but the start is the same.
        msg = compose(meeting(timeZone='America/Toronto'), 'changed', previous=before)
        self.assertEqual(msg['Subject'], 'Meeting changed: Acme · Thu, Oct 22, 2:00 PM EDT')
        self.assertIn(
            '- When: was Thu, Oct 22, 2026, 2:00 – 3:00 PM EDT (New York time), '
            'now Thu, Oct 22, 2026, 2:00 – 3:00 PM EDT (Toronto time)\n', plain(msg),
        )
        msg = compose(meeting(endTime='16:00'), 'changed', previous=before)  # only the end
        self.assertEqual(msg['Subject'], 'Meeting changed: Acme · Thu, Oct 22, 2:00 PM EDT')
        self.assertIn('- When: was Thu, Oct 22, 2026, 2:00 – 3:00 PM EDT (New York time), now', plain(msg))
        # A date-only meeting moved to the next day did move.
        msg = compose(meeting(dueDate='2026-10-23', dueTime='', endTime=''), 'changed',
                      previous=dayplan_mail.snapshot(meeting(dueTime='', endTime='')))
        self.assertEqual(msg['Subject'], 'Meeting changed: Acme · now Fri, Oct 23')

    @needs_zones
    def test_changes_nobody_would_see_go_out_as_the_details(self):
        date_only = {'dueTime': '', 'endTime': ''}
        cases = [
            # A date-only meeting's time zone: the date reads the same in every zone.
            (meeting(**date_only), meeting(timeZone='Europe/Paris', **date_only), ['timeZone']),
            (meeting(**date_only), meeting(timeZone='Europe/Paris', **date_only), ()),
            (meeting(**date_only), None, ['timeZone']),
            # An end time without a start time isn't shown.
            (meeting(dueTime='', endTime=''), meeting(dueTime='', endTime='16:00'), ['endTime']),
            # A title that only differs in its spaces.
            (meeting(title='Interview   with Acme'), meeting(), ['title']),
            # A link that cleans up the same.
            (meeting(meetingUrl='zoom.us/j/123'), meeting(), ['meetingUrl']),
        ]
        for after, before, changes in cases:
            previous = dayplan_mail.snapshot(before) if before is not None else None
            msg = compose(after, 'changed', previous=previous, changes=changes)
            label = (after.get('timeZone'), changes)
            self.assertTrue(msg['Subject'].startswith('Meeting details: Acme · Thu, Oct 22'), label)
            self.assertNotIn('now', msg['Subject'], label)
            text = plain(msg)
            self.assertTrue(text.startswith('Meeting details: '), label)
            self.assertNotIn('What changed', text, label)
            self.assertNotIn('What changed', html_of(msg), label)
            self.assertIn('add this meeting to your calendar', text, label)
            parsed(msg)

    def test_folding(self):
        title = 'Entretien d’embauche à Zürich — équipe produit, étape finale ' * 3
        msg = compose(meeting(title=title, company='', meetingUrl='https://example.com/' + 'x' * 150))
        ics = ics_of(msg)
        for line in ics.split('\r\n'):
            self.assertLessEqual(len(line.encode('utf-8')), 75)
        lines = unfolded(ics)
        summary = [line for line in lines if line.startswith('SUMMARY:')][0]
        self.assertEqual(summary, 'SUMMARY:' + title.strip().replace(',', '\\,'))
        self.assertIn('URL:https://example.com/' + 'x' * 150, lines)

    def test_calendar_text_is_escaped(self):
        msg = compose(meeting(title='Call; then, a \\ chat', company='A\nB'))
        lines = unfolded(ics_of(msg))
        self.assertIn('SUMMARY:Call\\; then\\, a \\\\ chat', lines)
        self.assertIn('Company: A B', [line for line in lines if line.startswith('DESCRIPTION:Company')][0])

    def test_without_zoneinfo(self):
        with mock.patch.object(dayplan_mail, 'ZoneInfo', None):
            msg = compose(meeting(), recipient_zone='Europe/Berlin')
            self.assertEqual(msg['Subject'], 'New meeting: Acme · Thu, Oct 22, 2:00 PM (New York time)')
            self.assertIn('When: Thu, Oct 22, 2026, 2:00 – 3:00 PM (New York time)\n', plain(msg))
            self.assertNotIn('Your time', plain(msg))
            lines = unfolded(ics_of(msg))
            self.assertIn('DTSTART;TZID=America/New_York:20261022T140000', lines)
            self.assertIn('DTEND;TZID=America/New_York:20261022T150000', lines)
            msg = compose(meeting(timeZone='UTC'))
            self.assertIn('DTSTART:20261022T140000Z', unfolded(ics_of(msg)))

    def test_odd_input_still_makes_an_email(self):
        msg = compose({'id': 7, 'title': ['x'], 'company': None, 'dueDate': 20261022, 'resume': 'yes',
                       'coverLetter': {'id': 5}})
        self.assertEqual(msg['Subject'], 'New meeting: Meeting')
        self.assertIn('When: No date set', plain(msg))
        msg = compose(meeting(title='Lone \ud800 surrogate'))  # can come from JSON
        self.assertIn('Lone � surrogate', plain(msg))
        parsed(msg)

    def test_needs_settings(self):
        with self.assertRaises(MailError):
            compose(meeting(), config=None)
        with self.assertRaises(MailError):
            compose(meeting(), config={'username': 'a@example.com'})


class Injection(unittest.TestCase):
    def test_no_extra_headers_from_a_meeting(self):
        evil = 'Hello\r\nBcc: x@evil.com\r\n\r\nInjected body'
        msg = compose(meeting(title=evil, company=evil), config=dict(CONFIG, from_name='Dayplan\r\nBcc: y@evil.com'))
        raw = msg.as_bytes(policy=email.policy.SMTP)
        head = raw.split(b'\r\n\r\n', 1)[0]
        self.assertIsNone(re.search(rb'(?im)^bcc:', head))
        mail = parsed(msg)
        self.assertIsNone(mail.get_all('Bcc'))
        self.assertEqual(
            sorted(mail.keys()),
            sorted(['Subject', 'From', 'To', 'Date', 'Message-ID', 'Auto-Submitted', 'MIME-Version', 'Content-Type']),
        )
        self.assertEqual(mail.get_all('To'), ['viewer@example.com'])
        self.assertNotIn('\n', mail['Subject'])
        self.assertTrue(mail['Subject'].startswith('New meeting: Hello Bcc: x@evil.com Injected body'))

    def test_bad_recipients(self):
        for address in ('viewer@example.com\r\nBcc: x@evil.com', 'viewer@example.com, x@evil.com',
                        'Viewer <viewer@example.com>', 'not an email', '', None, 'a@b', 'a@b.co\nm', 'a@b.com\x00',
                        'a"b"@example.com', 'x' * 250 + '@example.com'):
            with self.assertRaises(ValueError, msg=repr(address)):
                compose(meeting(), recipient=address)
            with self.assertRaises(ValueError, msg=repr(address)):
                dayplan_mail.test_message(CONFIG, address)

    # Encoded words (RFC 2047) a To header would decode into more addresses.
    CRAFTED = (
        'a@=?utf-8?q?x.com=2cv1=40victim.org=2cv2=40victim.net?=',
        'a@=?utf-8?q?x.com=2Cv1=40victim.org?=',
        '=?utf-8?q?a=40x.com=2c?=b@example.com',
        'a@=?utf-8?b?eC5jb20sdkB2aWN0aW0ub3Jn?=.org',
        '9_%===40=_a=?utf-8?q?' + 'x' * 30 + '=?iso-8859-1?q?@=??b??=..ab}=28=2c',
        'x' * 28 + '=22-!=5c`=3c中*中@=??b?=0d29.qujd0qujd9',
    )

    def test_encoded_words_cannot_add_recipients(self):
        for address in self.CRAFTED:
            self.assertFalse(dayplan_mail._valid_address(address), address)
            with self.assertRaises(ValueError, msg=address):
                compose(meeting(), recipient=address)
            with self.assertRaises(ValueError, msg=address):
                dayplan_mail.test_message(CONFIG, address)

    def test_the_to_header_reads_back_as_just_the_address(self):
        # Even without the "=?" rule, the To header must read back as the one address.
        with mock.patch.object(dayplan_mail, 'ADDRESS_UNSAFE', re.compile(r'[\x00-\x1f<>(),;:"\[\]\\]')):
            for address in self.CRAFTED[:4]:
                with self.assertRaises(ValueError, msg=address):
                    compose(meeting(), recipient=address)

    def test_ordinary_addresses_still_work(self):
        for address in ('viewer@example.com', 'a.b+tag@example.co.uk', "o'neil@example.com", 'user@bücher.de',
                        'josé@example.com', 'a%b!c@example.com', 'x=y?z@example.com', 'a=b@example.com'):
            for msg in (compose(meeting(), recipient=address), dayplan_mail.test_message(CONFIG, address)):
                self.assertEqual([one.addr_spec for one in msg['To'].addresses], [address])
                recipients, mail = written(msg)
                self.assertEqual(recipients, [address])
                self.assertEqual([one.addr_spec for one in mail['To'].addresses], [address])

    def test_an_email_that_cannot_be_written_is_a_value_error(self):
        header_write_error = getattr(email.errors, 'HeaderWriteError', email.errors.HeaderParseError)
        for error in (IndexError('pop from empty list'), header_write_error('bad header'), AttributeError('x'),
                      UnicodeEncodeError('ascii', 'é', 0, 1, 'ordinal not in range(128)')):
            with mock.patch('dayplan_mail.BytesGenerator.flatten', side_effect=error):
                with self.assertRaises(ValueError, msg=repr(error)):
                    compose(meeting())
                with self.assertRaises(ValueError, msg=repr(error)):
                    dayplan_mail.test_message(CONFIG, 'me@example.com')

    def test_a_to_header_the_parser_trips_over_is_a_value_error(self):
        real = dayplan_mail.EmailMessage.__setitem__

        def tripping(msg, name, value):
            if name == 'To':
                raise IndexError('pop from empty list')
            return real(msg, name, value)

        with mock.patch.object(dayplan_mail.EmailMessage, '__setitem__', tripping):
            with self.assertRaises(ValueError):
                compose(meeting())
            with self.assertRaises(ValueError):
                dayplan_mail.test_message(CONFIG, 'me@example.com')
        broken = mock.MagicMock()
        broken.__getitem__.side_effect = IndexError('pop from empty list')
        self.assertEqual(dayplan_mail._header_address(broken), '')
        self.assertEqual(dayplan_mail._header_address(None), '')

    def test_odd_addresses(self):
        """Random addresses that pass the check: each one either can't be emailed
        (ValueError) or makes an email smtplib sends to exactly that address."""
        rng = random.Random(2047)
        alphabet = 'abcxyz019.-_+=?%!`{}|~#$&\'*/^@中éßİ\u200b\ufeff'
        tried = written_ok = 0
        while tried < 250:
            address = '{}@{}.{}'.format(
                ''.join(rng.choice(alphabet) for _ in range(rng.randint(1, 50))),
                ''.join(rng.choice(alphabet) for _ in range(rng.randint(1, 20))),
                ''.join(rng.choice(alphabet) for _ in range(rng.randint(1, 8))),
            )
            if not dayplan_mail._valid_address(address):
                continue
            tried += 1
            for make in (lambda: compose(meeting(), recipient=address),
                         lambda: dayplan_mail.test_message(CONFIG, address)):
                try:
                    msg = make()
                except ValueError:
                    continue
                recipients, mail = written(msg)
                self.assertEqual(recipients, [address])
                self.assertEqual([one.addr_spec for one in mail['To'].addresses], [address])
                written_ok += 1
        self.assertGreater(written_ok, 100)  # the test did test something

    def test_html_is_escaped(self):
        msg = compose(meeting(title='<script>alert(1)</script>', company='Tom & "Jerry" <b>'))
        page = html_of(msg)
        self.assertNotIn('<script>', page)
        self.assertIn('&lt;script&gt;alert(1)&lt;/script&gt;', page)
        self.assertIn('Tom &amp; &quot;Jerry&quot; &lt;b&gt;', page)

    def test_only_web_links_become_links(self):
        msg = compose(meeting(meetingUrl='javascript:alert(document.cookie)', jobUrl='data:text/html,<b>x</b>'),
                      site_url='javascript:alert(2)')
        page = html_of(msg)
        self.assertNotIn('javascript:', page.lower())
        self.assertNotIn('data:', page)
        self.assertNotIn('Join link', plain(msg))
        self.assertNotIn('Open Dayplan', plain(msg))
        self.assertEqual(page.count('<a '), 0)

    def test_quotes_in_links_cannot_break_out(self):
        page = html_of(compose(meeting(meetingUrl='https://example.com/x" onmouseover="alert(1)')))
        self.assertNotIn('onmouseover="', page)
        page = html_of(compose(meeting(meetingUrl='https://example.com/x"onmouseover="alert(1)')))
        self.assertIn('href="https://example.com/x%22onmouseover=%22alert(1)"', page)


class TestMessage(unittest.TestCase):
    def test_test_message(self):
        msg = dayplan_mail.test_message(CONFIG, 'me@example.com', SITE)
        self.assertEqual(msg['Subject'], 'Dayplan email test')
        self.assertEqual(msg['To'], 'me@example.com')
        self.assertEqual(msg['From'], 'Dayplan <planner@gmail.com>')
        self.assertEqual(msg['Auto-Submitted'], 'auto-generated')
        text = msg.get_content()
        self.assertIn('emails from Dayplan work', text)
        self.assertIn('planner@gmail.com through smtp.gmail.com', text)
        self.assertIn(SITE, text)
        self.assertNotIn(PASSWORD, msg.as_string())
        self.assertNotIn('Open Dayplan', dayplan_mail.test_message(CONFIG, 'me@example.com').get_content())

    def test_says_emails_are_on_unless_turned_off(self):
        text = ' '.join(dayplan_mail.test_message(CONFIG, 'me@example.com').get_content().split())
        self.assertIn(
            'Approved accounts get an email when you send one about a meeting (added, changed or cancelled), '
            'unless they turn these emails off in their account menu.', text,
        )
        self.assertNotIn('ask for them', text)

    def test_needs_settings(self):
        with self.assertRaises(MailError) as caught:
            dayplan_mail.test_message(None, 'me@example.com')
        self.assertFalse(caught.exception.retry)


# ------------------------------------------------------------------- sending

def fake_smtp(connect=None, starttls=None, login=None, refuse=(), on_send=None, on_quit=None):
    """A stand-in for smtplib.SMTP that records every call. Each argument is an
    exception to raise at that step; `refuse` holds recipients the server
    refuses, and on_send(index, msg) may raise for any message. Each send is
    logged with the envelope's recipients (what the server delivers to)."""
    log = []

    class FakeSMTP:
        def __init__(self, host, port, timeout=None):
            log.append(('connect', host, port, timeout))
            if connect:
                raise connect

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            log.append(('quit',))
            if on_quit:
                raise on_quit
            return False

        def ehlo(self):
            log.append(('ehlo',))

        def starttls(self, context=None):
            log.append(('starttls', isinstance(context, ssl.SSLContext)))
            if starttls:
                raise starttls

        def login(self, user, password):
            log.append(('login', user, password))
            if login:
                raise login

        def send_message(self, msg, to_addrs=None):
            index = len([entry for entry in log if entry[0] == 'send'])
            if to_addrs is None:  # send() always says who to deliver to
                raise AssertionError('no envelope recipients')
            log.append(('send',) + tuple(to_addrs))
            refused = {address: (550, b'5.1.1 No such user') for address in to_addrs if address in refuse}
            if refused:
                raise smtplib.SMTPRecipientsRefused(refused)
            if on_send:
                on_send(index, msg)

    return FakeSMTP, log


class Send(unittest.TestCase):
    RECIPIENTS = ['one@example.com', 'two@example.com', 'three@example.com']

    def messages(self):
        return [compose(meeting(timeZone=''), recipient=address) for address in self.RECIPIENTS]

    def send(self, fake, messages=None, config=None):
        with mock.patch('dayplan_mail.smtplib.SMTP', fake):
            return dayplan_mail.send(config or CONFIG, self.messages() if messages is None else messages, timeout=7)

    def assertSafe(self, error):
        """A MailError that never mentions the password, nor where it came from."""
        self.assertNotIn(PASSWORD, str(error))
        self.assertIsNone(error.__cause__)
        self.assertTrue(error.__suppress_context__)

    def test_sends_one_email_per_recipient(self):
        fake, log = fake_smtp()
        result = self.send(fake)
        self.assertEqual(result, {'sent': self.RECIPIENTS, 'failed': []})
        self.assertEqual(log, [
            ('connect', 'smtp.gmail.com', 587, 7),
            ('ehlo',),
            ('starttls', True),
            ('ehlo',),
            ('login', 'planner@gmail.com', PASSWORD),
            ('send', 'one@example.com'),
            ('send', 'two@example.com'),
            ('send', 'three@example.com'),
            ('quit',),
        ])

    def test_a_refused_recipient_does_not_stop_the_others(self):
        fake, log = fake_smtp(refuse={'two@example.com'})
        self.assertEqual(self.send(fake), {'sent': ['one@example.com', 'three@example.com'], 'failed': ['two@example.com']})

    def test_a_rejected_message_does_not_stop_the_others(self):
        def refuse(index, msg):
            if index == 0:
                raise smtplib.SMTPDataError(550, b'5.7.1 Message rejected')
            if index == 1:
                raise smtplib.SMTPDataError(554, b'5.7.0 Message looks like spam')
        fake, log = fake_smtp(on_send=refuse)
        self.assertEqual(self.send(fake), {'sent': ['three@example.com'], 'failed': ['one@example.com', 'two@example.com']})

    def test_a_broken_connection_fails_the_rest(self):
        for error in (smtplib.SMTPServerDisconnected('gone'), socket.timeout('timed out'), ConnectionResetError()):
            def drop(index, msg, error=error):
                if index == 1:
                    raise error
            fake, log = fake_smtp(on_send=drop)
            self.assertEqual(
                self.send(fake), {'sent': ['one@example.com'], 'failed': ['two@example.com', 'three@example.com']}
            )
            sends = [entry for entry in log if entry[0] == 'send']
            self.assertEqual(sends, [('send', 'one@example.com'), ('send', 'two@example.com')])

    def test_a_failed_goodbye_still_counts_as_sent(self):
        fake, log = fake_smtp(on_quit=socket.timeout('timed out'))
        self.assertEqual(self.send(fake), {'sent': self.RECIPIENTS, 'failed': []})

    def test_wrong_password(self):
        fake, log = fake_smtp(login=smtplib.SMTPAuthenticationError(
            535, b'5.7.8 Username and Password not accepted. ' + PASSWORD.encode()
        ))
        with self.assertRaises(MailError) as caught:
            self.send(fake)
        message = str(caught.exception)
        self.assertIn('app password', message)
        self.assertIn('python3 ~/Todo_app/dayplan_api.py setup-email', message)
        self.assertSafe(caught.exception)
        self.assertFalse(caught.exception.retry)  # trying again can't help
        self.assertNotIn('send', [entry[0] for entry in log])

    def test_cannot_connect(self):
        for error in (ConnectionRefusedError(111, 'Connection refused'), socket.gaierror(-2, 'Name or service not known'),
                      OSError(101, 'Network is unreachable'), smtplib.SMTPConnectError(421, b'busy')):
            fake, log = fake_smtp(connect=error)
            with self.assertRaises(MailError) as caught:
                self.send(fake)
            self.assertIn('Could not connect to the email server smtp.gmail.com', str(caught.exception))
            self.assertSafe(caught.exception)
            self.assertTrue(caught.exception.retry)

    def test_timeouts(self):
        for step in ('connect', 'starttls', 'login'):
            fake, log = fake_smtp(**{step: socket.timeout('timed out')})
            with self.assertRaises(MailError) as caught:
                self.send(fake)
            self.assertIn('did not answer in time', str(caught.exception))
            self.assertSafe(caught.exception)
            self.assertTrue(caught.exception.retry)

    def test_no_secure_connection(self):
        for error in (ssl.SSLError('certificate verify failed'), smtplib.SMTPNotSupportedError('no STARTTLS')):
            fake, log = fake_smtp(starttls=error)
            with self.assertRaises(MailError) as caught:
                self.send(fake)
            self.assertIn('secure connection', str(caught.exception))
            self.assertNotIn('login', [entry[0] for entry in log])  # the password is never sent unencrypted

    def test_other_sign_in_problems(self):
        for error, retry in ((smtplib.SMTPException('No suitable authentication method found.'), True),
                             (UnicodeEncodeError('ascii', PASSWORD + 'é', 16, 17, 'ordinal not in range(128)'), False)):
            fake, log = fake_smtp(login=error)
            with self.assertRaises(MailError) as caught:
                self.send(fake)
            self.assertIn('setup-email', str(caught.exception))
            self.assertSafe(caught.exception)
            self.assertEqual(caught.exception.retry, retry)

    def test_nothing_to_send(self):
        fake, log = fake_smtp(connect=AssertionError('should not connect'))
        self.assertEqual(self.send(fake, messages=[]), {'sent': [], 'failed': []})
        self.assertEqual(log, [])

    def test_needs_settings(self):
        fake, log = fake_smtp()
        with mock.patch('dayplan_mail.smtplib.SMTP', fake):
            with self.assertRaises(MailError) as caught:
                dayplan_mail.send(None, self.messages())
        self.assertIn('setup-email', str(caught.exception))
        self.assertFalse(caught.exception.retry)
        self.assertEqual(log, [])

    def test_own_server(self):
        fake, log = fake_smtp()
        self.send(fake, config=dict(CONFIG, host='smtp.example.com', port=2525))
        self.assertEqual(log[0], ('connect', 'smtp.example.com', 2525, 7))

    def test_sends_the_test_message(self):
        fake, log = fake_smtp()
        with mock.patch('dayplan_mail.smtplib.SMTP', fake):
            result = dayplan_mail.send(CONFIG, [dayplan_mail.test_message(CONFIG, 'me@example.com')])
        self.assertEqual(result, {'sent': ['me@example.com'], 'failed': []})
        self.assertEqual(log[0], ('connect', 'smtp.gmail.com', 587, 20))

    def test_mail_error_retry(self):
        self.assertTrue(MailError('Gmail did not answer.').retry)
        self.assertFalse(MailError('Gmail refused the sign-in.', retry=False).retry)
        self.assertEqual(str(MailError('Plain words.', retry=False)), 'Plain words.')

    # ------------------------------------------- what the server delivers to

    def test_each_email_goes_only_to_its_own_address(self):
        connect, servers = scripted()
        with mock.patch('dayplan_mail.smtplib.SMTP', connect):
            result = dayplan_mail.send(CONFIG, self.messages(), timeout=7)
        self.assertEqual(result, {'sent': self.RECIPIENTS, 'failed': []})
        self.assertEqual(servers[0].envelopes, [['planner@gmail.com', [address]] for address in self.RECIPIENTS])
        for (recipients, raw), address in zip(servers[0].delivered, self.RECIPIENTS):
            self.assertEqual(recipients, [address])
            mail = email.message_from_bytes(raw, policy=email.policy.default)
            self.assertEqual([one.addr_spec for one in mail['To'].addresses], [address])

    def test_an_email_whose_to_header_is_not_one_address_is_not_sent(self):
        messages = self.messages()
        messages[1].replace_header('To', 'two@example.com, extra@victim.org')  # changed after compose()
        crafted = email.message.EmailMessage()
        crafted['From'] = 'planner@gmail.com'
        crafted['To'] = 'a@=?utf-8?q?x.com=2Cv1=40victim.org=2Cv2=40victim.net?='  # an email not made here
        crafted.set_content('Hello')
        empty = email.message.EmailMessage()
        empty.set_content('No To header')
        connect, servers = scripted()
        with mock.patch('dayplan_mail.smtplib.SMTP', connect):
            result = dayplan_mail.send(CONFIG, messages + [crafted, empty])
        self.assertEqual(result['sent'], ['one@example.com', 'three@example.com'])
        self.assertEqual(len(result['failed']), 3)
        self.assertEqual(
            [recipients for _, recipients in servers[0].envelopes], [['one@example.com'], ['three@example.com']],
        )

    def test_an_email_that_breaks_while_being_written_only_fails_itself(self):
        header_write_error = getattr(email.errors, 'HeaderWriteError', email.errors.HeaderParseError)
        for error in (IndexError('pop from empty list'), header_write_error('bad header'), TypeError('odd'),
                      ValueError('bad'), UnicodeEncodeError('ascii', 'é', 0, 1, 'no'),
                      smtplib.SMTPNotSupportedError('no SMTPUTF8')):
            def explode(index, msg, error=error):
                if index == 1:
                    raise error
            fake, log = fake_smtp(on_send=explode)
            self.assertEqual(
                self.send(fake), {'sent': ['one@example.com', 'three@example.com'], 'failed': ['two@example.com']},
                repr(error),
            )

    # ----------------------------------------- refusals from the real smtplib

    LIMIT = (550, b'5.4.5 Daily user sending limit exceeded. For more information, visit\n'
                  b'5.4.5  https://support.google.com/a/answer/166852 ' + PASSWORD.encode() + b' - gsmtp')
    BUSY = (421, b'4.7.0 Try again later, closing connection. (MAIL) ' + PASSWORD.encode() + b' - gsmtp')

    def send_scripted(self, replies):
        connect, servers = scripted(replies)
        with mock.patch('dayplan_mail.smtplib.SMTP', connect):
            return dayplan_mail.send(CONFIG, self.messages()), servers[0]

    def assertQuiet(self, error):
        """A MailError that doesn't repeat any of the server's own words."""
        self.assertSafe(error)
        for words in ('gsmtp', 'support.google.com', 'exceeded', '5.4.5', '4.7.0', 'closing connection', 'Try again later'):
            self.assertNotIn(words, str(error))

    def test_gmail_sending_limit(self):
        for step in ('mail', 'rcpt', 'data'):
            with self.assertRaises(MailError, msg=step) as caught:
                self.send_scripted({step: {0: self.LIMIT}})
            message = str(caught.exception)
            self.assertIn("Gmail's daily sending limit", message)
            self.assertIn('try again tomorrow', message)
            self.assertFalse(caught.exception.retry)
            self.assertQuiet(caught.exception)
        for reply in ((550, b'5.4.5 Daily SMTP relay sending limit exceeded'), (550, b'Daily sending quota exceeded')):
            with self.assertRaises(MailError) as caught:
                self.send_scripted({'mail': {0: reply}})
            self.assertFalse(caught.exception.retry)

    def test_the_sending_limit_stops_the_rest(self):
        connect, servers = scripted({'mail': {0: self.LIMIT}})
        with mock.patch('dayplan_mail.smtplib.SMTP', connect), self.assertRaises(MailError):
            dayplan_mail.send(CONFIG, self.messages())
        self.assertEqual(len(servers[0].envelopes), 1)  # no use asking about the other two
        result, server = self.send_scripted({'mail': {1: self.LIMIT}})
        self.assertEqual(result, {'sent': ['one@example.com'], 'failed': ['two@example.com', 'three@example.com']})
        self.assertEqual(len(server.envelopes), 2)

    def test_try_again_later(self):
        # 421: Gmail is closing the connection (too many emails just now, say).
        for step in ('mail', 'rcpt', 'data'):
            with self.assertRaises(MailError, msg=step) as caught:
                self.send_scripted({step: {0: self.BUSY}})
            message = str(caught.exception)
            self.assertIn('smtp.gmail.com is not taking emails just now', message)
            self.assertIn('try again in a few minutes', message)
            self.assertTrue(caught.exception.retry)
            self.assertQuiet(caught.exception)
        result, server = self.send_scripted({'rcpt': {1: self.BUSY}})
        self.assertEqual(result, {'sent': ['one@example.com'], 'failed': ['two@example.com', 'three@example.com']})
        self.assertTrue(server.closed)

    def test_the_sender_refused(self):
        with self.assertRaises(MailError) as caught:
            self.send_scripted({'mail': {0: (553, b'5.7.1 Sender ' + PASSWORD.encode() + b' not allowed')}})
        self.assertIn('would not send emails from this account just now', str(caught.exception))
        self.assertTrue(caught.exception.retry)
        self.assertQuiet(caught.exception)
        self.assertNotIn('not allowed', str(caught.exception))

    def test_one_refused_recipient_or_message(self):
        for step, reply in (('rcpt', (550, b'5.1.1 The email account that you tried to reach does not exist.')),
                            ('rcpt', (452, b'4.2.2 The email account that you tried to reach is over quota.')),
                            ('data', (552, b'5.7.0 This message was blocked because its content presents a risk.')),
                            ('data', (554, b'5.6.0 Message rejected'))):
            result, server = self.send_scripted({step: {1: reply}})
            self.assertEqual(
                result, {'sent': ['one@example.com', 'three@example.com'], 'failed': ['two@example.com']}, reply,
            )
            self.assertEqual(len(server.envelopes), 3)

    def test_no_answer_before_the_first_email(self):
        for error, words in ((socket.timeout('timed out'), 'did not answer in time'),
                             (smtplib.SMTPServerDisconnected('Connection unexpectedly closed'), 'closed the connection'),
                             (ConnectionResetError(104, 'Connection reset by peer'), 'closed the connection')):
            for step in ('mail', 'data'):
                with self.assertRaises(MailError, msg=(step, error)) as caught:
                    self.send_scripted({step: {0: error}})
                self.assertIn(words, str(caught.exception))
                self.assertIn('try again in a few minutes', str(caught.exception))
                self.assertTrue(caught.exception.retry)
                self.assertSafe(caught.exception)

    def test_no_answer_after_some_went(self):
        result, server = self.send_scripted({'data': {2: socket.timeout('timed out')}})
        self.assertEqual(result, {'sent': ['one@example.com', 'two@example.com'], 'failed': ['three@example.com']})


if __name__ == '__main__':
    unittest.main()
