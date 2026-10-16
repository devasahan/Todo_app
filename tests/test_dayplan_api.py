"""Tests for dayplan_api.py. Run with: python3 -m unittest discover -s tests"""
import io
import json
import os
import re
import smtplib
import sqlite3
import stat
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from urllib.parse import quote
from wsgiref.util import setup_testing_defaults

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import dayplan_api  # noqa: E402
import dayplan_mail  # noqa: E402
from dayplan_wsgi import application  # noqa: E402

EMAIL = 'me@example.com'
PASSWORD = 'correct horse battery'
# A meeting's own fields, which an older version of the app drops when it saves.
MEETING = {
    'kind': 'meeting',
    'company': 'Acme',
    'meetingUrl': 'https://example.com/j/1',
    'jobUrl': 'https://example.com/jobs/1',
}
# A tiny but real-looking PDF file.
PDF = b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'
# The Gmail account that sends meeting emails, and a made-up app password for
# it. The password must never show up in an answer, an email or the output.
SENDER = 'dayplan.sender@gmail.com'
APP_PASSWORD = 'wxyzqrstuvklmnop'
# zoneinfo and its time zone data (Python 3.9+; most systems have the data).
HAS_ZONES = dayplan_mail.ZoneInfo is not None and dayplan_mail.valid_zone('America/New_York')
_clock = [0]


def stamp(offset=None):
    """Increasing ISO times, like a plan's updatedAt (or a given offset in seconds)."""
    if offset is None:
        _clock[0] += 1
        offset = _clock[0]
    base = datetime(2026, 10, 14, 9, 0, tzinfo=timezone.utc) + timedelta(seconds=offset)
    return base.strftime('%Y-%m-%dT%H:%M:%S.000Z')


def public(email, admin=False, notify=True, zone=''):
    """An account as the API describes it to the app."""
    return {'email': email, 'admin': admin, 'notify': notify, 'timeZone': zone}


def sync_part(res):
    """The sync fields of a response (an admin's replies also include a pending count)."""
    return {k: v for k, v in res['json'].items() if k in ('cursor', 'changes', 'reset')}


class Client:
    """A tiny browser: keeps the session cookie between requests."""

    def __init__(self, host='dayplan.example.com', https=True):
        self.cookie = ''
        self.host = host
        self.https = https
        self.ip = ''

    def request(self, method, path, body=None, content_type='application/json', origin='same', headers=None):
        data = b'' if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        environ = {}
        setup_testing_defaults(environ)
        environ.update({
            'REQUEST_METHOD': method,
            'PATH_INFO': path,
            'HTTP_HOST': self.host,
            'CONTENT_LENGTH': str(len(data)),
            'wsgi.input': io.BytesIO(data),
            'wsgi.url_scheme': 'https' if self.https else 'http',
        })
        if method == 'POST':
            environ['CONTENT_TYPE'] = content_type
            if origin == 'same':
                environ['HTTP_ORIGIN'] = ('https://' if self.https else 'http://') + self.host
            elif origin:
                environ['HTTP_ORIGIN'] = origin
        if self.cookie:
            environ['HTTP_COOKIE'] = self.cookie
        if self.ip:
            environ['HTTP_X_REAL_IP'] = self.ip
        for name, value in (headers or {}).items():
            environ['HTTP_' + name.upper().replace('-', '_')] = value
        captured = {}

        def start_response(status, response_headers):
            captured['status'] = int(status.split()[0])
            captured['headers'] = response_headers

        raw = b''.join(application(environ, start_response))
        for name, value in captured['headers']:
            if name == 'Set-Cookie':
                pair = value.split(';')[0]
                self.cookie = '' if pair.endswith('=') else pair
                captured['set_cookie'] = value
        captured['body'] = raw
        is_json = dict(captured['headers']).get('Content-Type') == 'application/json'
        captured['json'] = json.loads(raw) if raw and is_json else None
        return captured

    def post(self, path, body=None, **kwargs):
        return self.request('POST', path, body, **kwargs)

    def get(self, path):
        return self.request('GET', path)

    def upload(self, data=PDF, name='resume.pdf', **kwargs):
        """Sends a file the way the app does (a `name` of None sends no name at all)."""
        headers = {} if name is None else {'X-File-Name': quote(name, safe='')}
        return self.post('/api/files', data, content_type='application/pdf', headers=headers, **kwargs)


def text_of(msg):
    """An email's plain-text part."""
    return msg.get_body(('plain',)).get_content()


def html_of(msg):
    return msg.get_body(('html',)).get_content()


def calendar_of(msg):
    """An email's calendar file (.ics) as text, or None without one."""
    for part in msg.iter_attachments():
        if part.get_content_type() == 'text/calendar':
            return part.get_payload(decode=True).decode('utf-8')
    return None


def mail_error(message, retry):
    """A dayplan_mail.MailError that says whether trying again can help."""
    return dayplan_mail.MailError(message, retry=retry)


class FakeGmail:
    """Stands in for smtplib.SMTP: keeps the emails instead of sending them."""

    def __init__(self):
        self.messages = []  # the emails Gmail took
        self.connections = []  # (host, port) of each connection
        self.logins = []  # (username, password) of each sign-in
        self.refuse = set()  # addresses Gmail refuses
        self.login_error = None  # raised when signing in, e.g. for a wrong app password
        self.on_send = None  # called with each email before it is taken

    def __call__(self, host, port, timeout=None):
        self.connections.append((host, port))
        return FakeGmailConnection(self)

    def to(self):
        """Who the emails went to, in the order they went."""
        return [msg['To'] for msg in self.messages]


class FakeGmailConnection:
    def __init__(self, server):
        self.server = server

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def ehlo(self):
        pass

    def starttls(self, context=None):
        pass

    def login(self, username, password):
        if self.server.login_error:
            raise self.server.login_error
        self.server.logins.append((username, password))

    def send_message(self, msg, from_addr=None, to_addrs=None, **kwargs):
        if self.server.on_send:
            self.server.on_send(msg)
        if msg['To'] in self.server.refuse:
            raise smtplib.SMTPRecipientsRefused({msg['To']: (550, b'5.1.1 No such user')})
        self.server.messages.append(msg)


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.gmail = FakeGmail()
        patches = [
            mock.patch.dict(os.environ, {
                'DAYPLAN_DB': os.path.join(self.tmp.name, 'data', 'db.sqlite3'),
                'DAYPLAN_MAIL': os.path.join(self.tmp.name, 'data', 'mail.json'),
            }),
            mock.patch.object(dayplan_api, 'PBKDF2_ITERATIONS', 1000),  # keep tests fast
            # Every test client shares one address; tests of the per-address limit lower it.
            mock.patch.object(dayplan_api, 'MAX_PASSWORD_CHECKS_PER_ADDRESS', 1000),
            # No test ever reaches the real Gmail.
            mock.patch.object(dayplan_mail.smtplib, 'SMTP', self.gmail),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        dayplan_api._dummy_hash = None
        self.addCleanup(self.tmp.cleanup)

    def signed_in(self, email=EMAIL, password=PASSWORD):
        """Signs up the site's first account (the admin)."""
        client = Client()
        res = client.post('/api/register', {'email': email, 'password': password})
        self.assertEqual(res['status'], 201, res['json'])
        return client

    def member(self, email, password=PASSWORD, admin=False):
        """An approved, signed-in second account (view-only unless `admin`)."""
        conn = dayplan_api.connect()
        dayplan_api.set_password(conn, email, password, admin=admin)
        conn.close()
        client = Client()
        self.assertEqual(client.post('/api/login', {'email': email, 'password': password})['status'], 200)
        return client

    def stored_directly(self, email, *changes):
        """Puts plans straight into an account's storage, the way a member's
        plans were saved before members became view-only."""
        conn = dayplan_api.connect()
        with conn:
            user_id = conn.execute('SELECT id FROM users WHERE email = ?', (email,)).fetchone()[0]
            for rev, change in enumerate(changes, start=1):
                conn.execute(
                    'INSERT INTO plans (user_id, id, data, rev, updated_at) VALUES (?, ?, ?, ?, ?)',
                    (user_id, change['id'], json.dumps(change['data']), rev, change['data']['updatedAt']),
                )
        conn.close()

    def plans_of(self, email):
        """Every stored row (including deletions) of an account, as {id: data}."""
        conn = dayplan_api.connect()
        rows = conn.execute(
            'SELECT plans.id, plans.data FROM plans JOIN users ON users.id = plans.user_id WHERE users.email = ?',
            (email,),
        ).fetchall()
        conn.close()
        return {row['id']: row['data'] for row in rows}

    def plan(self, plan_id, title='Plan', at=None, **fields):
        return {'id': plan_id, 'data': {'id': plan_id, 'title': title, 'updatedAt': at or stamp(), **fields}}

    def deleted(self, plan_id, at=None):
        return {'id': plan_id, 'data': None, 'deletedAt': at or stamp()}


class Accounts(ApiTestCase):
    def test_first_account_is_the_admin(self):
        anon = Client()
        self.assertEqual(anon.get('/api/me')['json'], {'user': None, 'signup': True, 'first': True})
        client = self.signed_in()
        me = client.get('/api/me')['json']
        self.assertEqual(me['user'], public(EMAIL, admin=True))
        self.assertEqual(me['pending'], 0)
        self.assertIs(me['mailReady'], False)  # email isn't set up in these tests
        self.assertEqual(Client().get('/api/me')['json'], {'user': None, 'signup': True, 'first': False})

    def test_later_accounts_wait_for_approval(self):
        admin = self.signed_in()
        friend = Client()
        res = friend.post('/api/register', {'email': 'friend@example.com', 'password': PASSWORD})
        self.assertEqual(res['status'], 202)
        self.assertTrue(res['json']['pending'])
        self.assertNotIn('set_cookie', res)  # not signed in yet
        self.assertIsNone(friend.get('/api/me')['json']['user'])

        # Right password, but not approved yet: the same answer as a wrong password,
        # so nobody can use sign-up + sign-in to find out who has an account.
        waiting = friend.post('/api/login', {'email': 'friend@example.com', 'password': PASSWORD})
        wrong = friend.post('/api/login', {'email': 'friend@example.com', 'password': 'not it at all'})
        self.assertEqual(waiting['status'], 401)
        self.assertEqual(waiting['json'], wrong['json'])
        self.assertIn('approved', waiting['json']['error'])

        self.assertEqual(admin.get('/api/me')['json']['pending'], 1)
        sync = admin.post('/api/sync', {'cursor': 0, 'changes': []})['json']
        self.assertEqual(sync['pending'], 1)

        res = admin.post('/api/admin/users', {'email': 'friend@example.com', 'action': 'approve'})
        self.assertEqual(res['status'], 200)
        self.assertEqual(res['json']['pending'], 0)
        res = friend.post('/api/login', {'email': 'friend@example.com', 'password': PASSWORD})
        self.assertEqual(res['status'], 200)
        self.assertEqual(res['json']['user'], public('friend@example.com', admin=False))
        self.assertNotIn('pending', friend.get('/api/me')['json'])

    def test_sign_up_does_not_reveal_existing_accounts(self):
        self.signed_in()
        existing = Client().post('/api/register', {'email': EMAIL.upper(), 'password': 'attacker password'})
        new = Client().post('/api/register', {'email': 'brand-new@example.com', 'password': PASSWORD})
        self.assertEqual(existing['status'], new['status'])
        self.assertEqual(existing['json'], new['json'])
        self.assertNotIn('set_cookie', existing)
        # The existing account is untouched: same password, still the admin.
        res = Client().post('/api/login', {'email': EMAIL, 'password': PASSWORD})
        self.assertEqual(res['json']['user'], public(EMAIL, admin=True))
        self.assertEqual(Client().post('/api/login', {'email': EMAIL, 'password': 'attacker password'})['status'], 401)

    def test_site_wide_limit_on_password_checks(self):
        self.signed_in()
        with mock.patch.object(dayplan_api, 'MAX_PASSWORD_CHECKS_PER_MINUTE', 3):
            # The first sign-up above happened before the patch but still counts: 1 used.
            for i in range(2):
                res = Client().post('/api/login', {'email': f'ghost{i}@example.com', 'password': PASSWORD})
                self.assertEqual(res['status'], 401)
            res = Client().post('/api/login', {'email': 'ghost9@example.com', 'password': PASSWORD})
            self.assertEqual(res['status'], 429)
            self.assertIn('wait a minute', res['json']['error'])
            res = Client().post('/api/register', {'email': 'new@example.com', 'password': PASSWORD})
            self.assertEqual(res['status'], 429)
            # Signed-in people keep working: sessions don't need a password check.
        conn = dayplan_api.connect()
        with conn:
            conn.execute('UPDATE password_checks SET at = at - 61')
        self.assertEqual(Client().post('/api/login', {'email': EMAIL, 'password': PASSWORD})['status'], 200)

    def test_password_is_hashed_never_stored(self):
        self.signed_in()
        conn = dayplan_api.connect()
        stored = conn.execute('SELECT password_hash FROM users').fetchone()[0]
        self.assertNotIn(PASSWORD, stored)
        self.assertTrue(stored.startswith('pbkdf2_sha256$'))
        self.assertTrue(dayplan_api.verify_password(PASSWORD, stored))
        self.assertFalse(dayplan_api.verify_password('wrong password', stored))
        self.assertFalse(dayplan_api.verify_password(PASSWORD, 'garbage'))

    def test_validation(self):
        client = Client()
        for body in [
            {'email': 'not-an-email', 'password': PASSWORD},
            {'email': EMAIL, 'password': 'short'},
            {'email': EMAIL},
            {'email': 42, 'password': PASSWORD},
            {'email': EMAIL, 'password': '\ud800' * 10},
        ]:
            self.assertEqual(client.post('/api/register', body)['status'], 400, body)

    def test_sign_up_refuses_addresses_that_could_email_strangers(self):
        admin = self.signed_in()
        conn = dayplan_api.connect()
        dayplan_api.set_password(conn, 'old,one@example.com', PASSWORD)  # made before this check
        conn.close()
        invalid = Client().post('/api/register', {'email': 'not-an-email', 'password': PASSWORD})
        self.assertEqual(invalid['status'], 400)
        for email in [
            # Encoded words, which mail programs decode: this one into three addresses.
            'a@=?utf-8?q?x.com=2Cv1=40victim.org=2Cv2=40victim.net?=',
            '=?utf-8?b?dkB2aWN0aW0ub3Jn?=@example.com',
            'a=?b@example.com',
            '=?UTF-8?Q?a?=@example.com',
            # Characters that separate or quote addresses in a To line.
            'a<b@example.com', 'a>b@example.com', 'a(b)@example.com', 'a,b@example.com', 'a;b@example.com',
            'a:b@example.com', '"a"@example.com', 'a[b]@example.com', 'a\\b@example.com',
            'old,one@example.com',  # the same answer for an account that exists
            # Spaces, control characters and invisible formatting ones.
            'a\x00b@example.com', 'a\x1fb@example.com', 'a\x7fb@example.com', 'a\x85b@example.com',
            'a\x9bb@example.com', 'a\rb@example.com', 'a@example.com\nBcc: v@victim.org',
            'a\u00a0b@example.com', 'a\u2028b@example.com', 'a\u200bb@example.com', 'a\u202eb@example.com',
            'a\ufeffb@example.com', 'a\ue000b@example.com',
        ]:
            res = Client().post('/api/register', {'email': email, 'password': PASSWORD})
            self.assertEqual((res['status'], res['json']), (invalid['status'], invalid['json']), repr(email))
            self.assertNotIn('set_cookie', res)
        self.assertEqual(admin.get('/api/me')['json']['pending'], 0)

        # Everyday and international addresses still can, with spaces around them trimmed.
        for email in ['first.last+dayplan@example.co.uk', "o'brien@example.com", 'josé@exämple.com',
                      '用户@例子.广告', '  padded@example.com\t']:
            res = Client().post('/api/register', {'email': email, 'password': PASSWORD})
            self.assertEqual(res['status'], 202, email)
        self.assertEqual(admin.get('/api/me')['json']['pending'], 5)
        # An account made before sign-ups were checked this closely can still sign in.
        res = Client().post('/api/login', {'email': 'old,one@example.com', 'password': PASSWORD})
        self.assertEqual(res['status'], 200)

    def test_login_logout(self):
        self.signed_in()
        client = Client()
        self.assertEqual(client.post('/api/login', {'email': EMAIL, 'password': 'nope nope'})['status'], 401)
        self.assertEqual(client.post('/api/login', {'email': 'x@example.com', 'password': PASSWORD})['status'], 401)
        res = client.post('/api/login', {'email': '  ME@Example.com ', 'password': PASSWORD})
        self.assertEqual(res['status'], 200)
        cookie = res['set_cookie']
        for flag in ('HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/'):
            self.assertIn(flag, cookie)
        self.assertEqual(client.get('/api/me')['json']['user'], public(EMAIL, admin=True))

        self.assertEqual(client.post('/api/logout')['status'], 200)
        self.assertIsNone(client.get('/api/me')['json']['user'])

    def test_no_secure_flag_over_plain_http(self):
        client = Client(https=False)
        res = client.post('/api/register', {'email': EMAIL, 'password': PASSWORD})
        self.assertNotIn('Secure', res['set_cookie'])

    def test_forged_and_expired_sessions_are_rejected(self):
        self.signed_in()
        forged = Client()
        forged.cookie = 'dayplan_session=made-up-token'
        self.assertIsNone(forged.get('/api/me')['json']['user'])
        broken = Client()
        broken.cookie = 'dayplan_session="unterminated'
        self.assertEqual(broken.get('/api/me')['status'], 200)

        client = Client()
        client.post('/api/login', {'email': EMAIL, 'password': PASSWORD})
        conn = dayplan_api.connect()
        with conn:
            conn.execute('UPDATE sessions SET expires_at = 0')
        self.assertIsNone(client.get('/api/me')['json']['user'])

    def test_too_many_failed_logins_are_throttled(self):
        self.signed_in()
        client = Client()
        for _ in range(dayplan_api.LOGIN_MAX_FAILURES):
            self.assertEqual(client.post('/api/login', {'email': EMAIL, 'password': 'wrong guess'})['status'], 401)
        self.assertEqual(client.post('/api/login', {'email': EMAIL, 'password': PASSWORD})['status'], 429)

    def test_a_stranger_cannot_lock_the_owner_out(self):
        self.signed_in()
        attacker = Client()
        attacker.ip = '203.0.113.9'
        for _ in range(dayplan_api.LOGIN_MAX_FAILURES + 2):
            attacker.post('/api/login', {'email': EMAIL, 'password': 'wrong guess'})
        self.assertEqual(attacker.post('/api/login', {'email': EMAIL, 'password': PASSWORD})['status'], 429)
        owner = Client()
        owner.ip = '198.51.100.7'
        self.assertEqual(owner.post('/api/login', {'email': EMAIL, 'password': PASSWORD})['status'], 200)

    def test_each_address_gets_only_a_share_of_password_checks(self):
        self.signed_in()
        with mock.patch.object(dayplan_api, 'MAX_PASSWORD_CHECKS_PER_ADDRESS', 2):
            stranger = Client()
            stranger.ip = '203.0.113.9'
            for i in range(2):
                self.assertEqual(stranger.post('/api/login', {'email': f'x{i}@example.com', 'password': PASSWORD})['status'], 401)
            res = stranger.post('/api/login', {'email': 'x9@example.com', 'password': PASSWORD})
            self.assertEqual(res['status'], 429)
            owner = Client()
            owner.ip = '198.51.100.7'
            self.assertEqual(owner.post('/api/login', {'email': EMAIL, 'password': PASSWORD})['status'], 200)

    def test_simultaneous_first_sign_ups_make_one_admin(self):
        results = []

        def sign_up(i):
            results.append(Client().post('/api/register', {'email': f'racer{i}@example.com', 'password': PASSWORD}))

        threads = [threading.Thread(target=sign_up, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(r['status'] for r in results), [201, 202, 202, 202, 202, 202])
        conn = dayplan_api.connect()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM users WHERE is_admin = 1').fetchone()[0], 1)

    def test_set_password_resets_and_signs_out_everywhere(self):
        client = self.signed_in()
        conn = dayplan_api.connect()
        dayplan_api.set_password(conn, EMAIL, 'a brand new password')
        self.assertIsNone(client.get('/api/me')['json']['user'])
        fresh = Client()
        self.assertEqual(fresh.post('/api/login', {'email': EMAIL, 'password': PASSWORD})['status'], 401)
        self.assertEqual(fresh.post('/api/login', {'email': EMAIL, 'password': 'a brand new password'})['status'], 200)


class CrossSiteProtection(ApiTestCase):
    def test_requires_json_and_same_origin(self):
        body = {'email': EMAIL, 'password': PASSWORD}
        self.assertEqual(Client().post('/api/register', body, content_type='text/plain')['status'], 415)
        self.assertEqual(
            Client().post('/api/register', body, content_type='application/x-www-form-urlencoded')['status'], 415
        )
        self.assertEqual(Client().post('/api/register', body, origin='https://evil.example')['status'], 403)
        self.assertEqual(Client().post('/api/register', body, origin=None)['status'], 201)

    def test_bad_requests(self):
        client = Client()
        self.assertEqual(client.post('/api/login', b'{not json')['status'], 400)
        self.assertEqual(client.post('/api/login', b'[1, 2]')['status'], 400)
        self.assertEqual(client.get('/api/login')['status'], 405)
        self.assertEqual(client.get('/api/nothing-here')['status'], 404)
        with mock.patch.object(dayplan_api, 'MAX_BODY_BYTES', 10):
            self.assertEqual(client.post('/api/login', {'email': EMAIL, 'password': PASSWORD})['status'], 413)


class Sync(ApiTestCase):
    def test_requires_sign_in(self):
        self.assertEqual(Client().post('/api/sync', {'cursor': 0, 'changes': []})['status'], 401)

    def test_two_browsers_share_plans(self):
        laptop = self.signed_in()
        res = laptop.post('/api/sync', {'cursor': 0, 'changes': [self.plan('a', 'Write report'), self.plan('b')]})
        self.assertEqual(res['status'], 200)
        self.assertEqual(sync_part(res), {'cursor': 2, 'changes': []})  # nothing echoed back

        phone = Client()
        phone.post('/api/login', {'email': EMAIL, 'password': PASSWORD})
        res = phone.post('/api/sync', {'cursor': 0, 'changes': []})
        self.assertEqual(res['json']['cursor'], 2)
        self.assertEqual(sorted(c['id'] for c in res['json']['changes']), ['a', 'b'])
        self.assertEqual(res['json']['changes'][0]['data']['title'], 'Write report')

        # The phone edits one plan and deletes the other.
        res = phone.post('/api/sync', {'cursor': 2, 'changes': [self.plan('a', 'Report v2'), self.deleted('b')]})
        self.assertEqual(sync_part(res), {'cursor': 4, 'changes': []})

        res = laptop.post('/api/sync', {'cursor': 2, 'changes': []})
        changes = {c['id']: c['data'] for c in res['json']['changes']}
        self.assertEqual(changes['a']['title'], 'Report v2')
        self.assertIsNone(changes['b'])
        self.assertEqual(res['json']['cursor'], 4)

        # Nothing new since then.
        self.assertEqual(sync_part(laptop.post('/api/sync', {'cursor': 4, 'changes': []})), {'cursor': 4, 'changes': []})

    def test_accounts_never_see_each_other(self):
        """Each admin account keeps its own plans. (Other accounts can't sync at all: see Viewers.)"""
        mine = self.signed_in()
        mine.post('/api/sync', {'cursor': 0, 'changes': [self.plan('secret', 'My diary')]})
        theirs = self.member('other@example.com', admin=True)
        res = theirs.post('/api/sync', {'cursor': 0, 'changes': []})
        self.assertEqual(sync_part(res), {'cursor': 0, 'changes': []})
        # Same plan id in another account is a separate plan.
        theirs.post('/api/sync', {'cursor': 0, 'changes': [self.plan('secret', 'Overwrite?')]})
        res = mine.post('/api/sync', {'cursor': 0, 'changes': []})
        self.assertEqual(res['json']['changes'][0]['data']['title'], 'My diary')

    def test_old_copies_never_overwrite_newer_changes(self):
        laptop = self.signed_in()
        t1, t2, t3 = stamp(), stamp(), stamp()
        laptop.post('/api/sync', {'cursor': 0, 'changes': [self.plan('a', 'Original', at=t1), self.plan('b', at=t1)]})
        phone = Client()
        phone.post('/api/login', {'email': EMAIL, 'password': PASSWORD})
        # The phone edits a and deletes b later on.
        phone.post('/api/sync', {'cursor': 2, 'changes': [self.plan('a', 'Phone edit', at=t3), self.deleted('b', at=t3)]})

        # The laptop, out of date, re-sends its old copies (e.g. after signing in again).
        res = laptop.post('/api/sync', {'cursor': 2, 'changes': [self.plan('a', 'Original', at=t1), self.plan('b', at=t2)]})
        changes = {c['id']: c['data'] for c in res['json']['changes']}
        self.assertEqual(changes['a']['title'], 'Phone edit')  # server's newer copy comes back
        self.assertIsNone(changes['b'])  # and b stays deleted
        res = phone.post('/api/sync', {'cursor': 0, 'changes': []})
        final = {c['id']: c['data'] for c in res['json']['changes']}
        self.assertEqual(final['a']['title'], 'Phone edit')
        self.assertIsNone(final['b'])

    def test_same_version_is_not_written_again(self):
        client = self.signed_in()
        t = stamp()
        first = client.post('/api/sync', {'cursor': 0, 'changes': [self.plan('a', at=t)]})['json']
        again = client.post('/api/sync', {'cursor': first['cursor'], 'changes': [self.plan('a', 'Other', at=t)]})['json']
        self.assertEqual(again['cursor'], first['cursor'])  # nothing saved
        self.assertEqual(again['changes'][0]['data']['title'], 'Plan')  # the server's copy is returned

    def test_newer_change_brings_back_a_deleted_plan(self):
        client = self.signed_in()
        client.post('/api/sync', {'cursor': 0, 'changes': [self.plan('a')]})
        client.post('/api/sync', {'cursor': 1, 'changes': [self.deleted('a')]})
        res = client.post('/api/sync', {'cursor': 2, 'changes': [self.plan('a', 'Undone delete')]})  # e.g. Undo
        self.assertEqual(sync_part(res), {'cursor': 3, 'changes': []})

    def test_changes_with_an_invalid_time_lose(self):
        client = self.signed_in()
        client.post('/api/sync', {'cursor': 0, 'changes': [self.plan('a', at=stamp(0))]})
        res = client.post('/api/sync', {'cursor': 1, 'changes': [{'id': 'a', 'data': None, 'deletedAt': 'yesterday'}]})
        self.assertEqual(res['json']['changes'][0]['data']['title'], 'Plan')
        res = client.post('/api/sync', {'cursor': 1, 'changes': [self.plan('a', 'x', at='yesterday')]})
        self.assertEqual(res['json']['changes'][0]['data']['title'], 'Plan')

    def test_deletion_from_an_old_app_version_uses_the_server_time(self):
        client = self.signed_in()
        client.post('/api/sync', {'cursor': 0, 'changes': [self.plan('a', at=stamp(0))]})
        res = client.post('/api/sync', {'cursor': 1, 'changes': [{'id': 'a', 'data': None}]})  # no deletedAt key
        self.assertEqual(sync_part(res), {'cursor': 2, 'changes': []})

    def test_times_in_other_iso_formats_compare_correctly(self):
        client = self.signed_in()
        client.post('/api/sync', {'cursor': 0, 'changes': [self.plan('a', 'First', at='2026-10-14T09:00:00.500Z')]})
        # Without milliseconds, 09:00:00Z is *earlier*, even though "Z" sorts after "." as text.
        res = client.post('/api/sync', {'cursor': 1, 'changes': [self.plan('a', 'Older', at='2026-10-14T09:00:00Z')]})
        self.assertEqual(res['json']['changes'][0]['data']['title'], 'First')
        res = client.post('/api/sync', {'cursor': 1, 'changes': [self.plan('a', 'Newer', at='2026-10-14T09:00:01Z')]})
        self.assertEqual(sync_part(res), {'cursor': 2, 'changes': []})

    def test_deletion_from_a_clock_running_ahead_cannot_beat_later_work(self):
        client = self.signed_in()
        client.post('/api/sync', {'cursor': 0, 'changes': [self.plan('a', at=dayplan_api.server_stamp(-60_000))]})
        two_hours_ahead = dayplan_api.server_stamp(2 * 3600 * 1000)
        client.post('/api/sync', {'cursor': 1, 'changes': [self.deleted('a', at=two_hours_ahead)]})
        conn = dayplan_api.connect()
        stored = conn.execute("SELECT updated_at FROM plans WHERE id = 'a'").fetchone()[0]
        self.assertLess(stored, dayplan_api.server_stamp(dayplan_api.MAX_CLOCK_AHEAD_MS + 5000))
        # An edit made a little later on a correct clock wins.
        later = dayplan_api.server_stamp(dayplan_api.MAX_CLOCK_AHEAD_MS + 1000)
        res = client.post('/api/sync', {'cursor': 2, 'changes': [self.plan('a', 'Still needed', at=later)]})
        self.assertEqual(sync_part(res), {'cursor': 3, 'changes': []})

    def test_restored_database_makes_browsers_start_over(self):
        client = self.signed_in()
        res = client.post('/api/sync', {'cursor': 0, 'changes': [self.plan('a')]})
        epoch = res['json']['epoch']
        self.assertTrue(epoch)
        same = client.post('/api/sync', {'epoch': epoch, 'cursor': 1, 'changes': []})
        self.assertNotIn('reset', same['json'])
        other = client.post('/api/sync', {'epoch': 'from-another-copy', 'cursor': 1, 'changes': [self.plan('b')]})
        self.assertEqual(other['json'], {'epoch': epoch, 'reset': True})
        self.assertEqual(sync_part(client.post('/api/sync', {'cursor': 0, 'changes': []}))['cursor'], 1)  # b not saved

    def test_a_database_that_went_backwards_gets_a_new_epoch(self):
        """A restored copy keeps its epoch; the first browser that is ahead triggers a new one."""
        laptop = self.signed_in()
        epoch = laptop.post('/api/sync', {'cursor': 0, 'changes': [self.plan('a'), self.plan('b')]})['json']['epoch']
        ahead = laptop.post('/api/sync', {'epoch': epoch, 'cursor': 9, 'changes': []})['json']
        self.assertTrue(ahead['reset'])
        self.assertNotEqual(ahead['epoch'], epoch)
        # A browser that was *behind* the restored copy is told to start over too.
        behind = laptop.post('/api/sync', {'epoch': epoch, 'cursor': 1, 'changes': []})['json']
        self.assertEqual(behind, {'epoch': ahead['epoch'], 'reset': True})

    def test_cursor_ahead_of_server_asks_for_reset(self):
        client = self.signed_in()
        res = client.post('/api/sync', {'cursor': 99, 'changes': [self.plan('a')]})
        self.assertEqual(sync_part(res), {'reset': True})
        # Nothing was saved from the rejected request.
        self.assertEqual(client.post('/api/sync', {'cursor': 0, 'changes': []})['json']['cursor'], 0)

    def test_full_pull_returns_every_plan(self):
        client = self.signed_in()
        client.post('/api/sync', {'cursor': 0, 'changes': [self.plan('a'), self.plan('b')]})
        res = client.post('/api/sync', {'cursor': 2, 'full': True, 'changes': []})
        self.assertEqual(res['json']['cursor'], 2)
        self.assertEqual(sorted(c['id'] for c in res['json']['changes']), ['a', 'b'])
        # Without the flag, only what changed since the cursor.
        self.assertEqual(sync_part(client.post('/api/sync', {'cursor': 2, 'changes': []})), {'cursor': 2, 'changes': []})

    def test_full_pull_still_notices_a_restored_database(self):
        client = self.signed_in()
        client.post('/api/sync', {'cursor': 0, 'changes': [self.plan('a')]})
        res = client.post('/api/sync', {'cursor': 9, 'full': True, 'changes': []})
        self.assertEqual(sync_part(res), {'reset': True})

    def test_deleting_unknown_plan_is_harmless(self):
        client = self.signed_in()
        res = client.post('/api/sync', {'cursor': 0, 'changes': [{'id': 'ghost', 'data': None}]})
        self.assertEqual(sync_part(res), {'cursor': 0, 'changes': []})

    def test_rejects_malformed_sync(self):
        client = self.signed_in()
        for body in [
            {'cursor': -1, 'changes': []},
            {'cursor': '0', 'changes': []},
            {'cursor': True, 'changes': []},
            {'cursor': 0, 'changes': 'nope'},
            {'cursor': 0, 'changes': [{'data': {}}]},
            {'cursor': 0, 'changes': [{'id': 'x', 'data': [1, 2]}]},
            {'cursor': 0, 'changes': [{'id': 'x' * 101, 'data': {}}]},
        ]:
            self.assertEqual(client.post('/api/sync', body)['status'], 400, body)
        huge = {'id': 'big', 'data': {'description': 'x' * (dayplan_api.MAX_PLAN_BYTES + 1)}}
        self.assertEqual(client.post('/api/sync', {'cursor': 0, 'changes': [huge]})['status'], 413)

    def test_plan_limit(self):
        client = self.signed_in()
        with mock.patch.object(dayplan_api, 'MAX_PLANS', 2):
            ok = client.post('/api/sync', {'cursor': 0, 'changes': [self.plan('a'), self.plan('b')]})
            self.assertEqual(ok['status'], 200)
            # Editing an existing plan is fine; adding a third is not.
            res = client.post('/api/sync', {'cursor': 2, 'changes': [self.plan('a', 'x')]})
            self.assertEqual(res['status'], 200)
            self.assertEqual(res['json']['cursor'], 3)
            self.assertEqual(client.post('/api/sync', {'cursor': 3, 'changes': [self.plan('c')]})['status'], 413)

    def test_fields_an_older_app_leaves_out_are_kept(self):
        laptop = self.signed_in()
        t1, t2 = stamp(), stamp()
        laptop.post('/api/sync', {'cursor': 0, 'changes': [self.plan('m', 'Interview with Acme', at=t1, **MEETING)]})
        # A tab still running an older version renames it, leaving out the fields it doesn't know.
        res = laptop.post('/api/sync', {'cursor': 1, 'changes': [self.plan('m', 'Renamed', at=t2)]})
        self.assertEqual(sync_part(res), {'cursor': 2, 'changes': []})  # the merged copy isn't echoed back

        phone = Client()
        phone.post('/api/login', {'email': EMAIL, 'password': PASSWORD})
        res = phone.post('/api/sync', {'cursor': 0, 'changes': []})
        self.assertEqual(res['json']['changes'][0]['data'], {'id': 'm', 'title': 'Renamed', 'updatedAt': t2, **MEETING})

    def test_a_field_sent_empty_is_cleared(self):
        client = self.signed_in()
        client.post('/api/sync', {'cursor': 0, 'changes': [self.plan('m', 'Interview with Acme', **MEETING)]})
        as_plan = self.plan('m', 'Interview with Acme', kind='plan', company='', meetingUrl='', jobUrl='')
        client.post('/api/sync', {'cursor': 1, 'changes': [as_plan]})
        res = client.post('/api/sync', {'cursor': 0, 'changes': []})
        self.assertEqual(res['json']['changes'][0]['data'], as_plan['data'])

    def test_a_deleted_plan_does_not_get_old_fields_back(self):
        client = self.signed_in()
        client.post('/api/sync', {'cursor': 0, 'changes': [self.plan('m', 'Interview with Acme', **MEETING)]})
        client.post('/api/sync', {'cursor': 1, 'changes': [self.deleted('m')]})
        res = client.post('/api/sync', {'cursor': 2, 'changes': [self.plan('m', 'Fresh start')]})
        self.assertEqual(sync_part(res), {'cursor': 3, 'changes': []})
        data = client.post('/api/sync', {'cursor': 0, 'changes': []})['json']['changes'][0]['data']
        self.assertEqual(data['title'], 'Fresh start')
        self.assertNotIn('company', data)

    def test_out_of_date_copies_are_not_merged(self):
        client = self.signed_in()
        t1, t2 = stamp(), stamp()
        current = self.plan('m', 'Interview with Acme', at=t2, **MEETING)
        client.post('/api/sync', {'cursor': 0, 'changes': [current]})
        res = client.post('/api/sync', {'cursor': 1, 'changes': [self.plan('m', 'Old title', at=t1, notes='Old notes')]})
        # Refused: the server's own copy comes back unchanged, and nothing new was saved.
        self.assertEqual(sync_part(res), {'cursor': 1, 'changes': [current]})

    def test_a_merge_that_would_be_too_large_keeps_the_server_copy(self):
        client = self.signed_in()
        current = self.plan('m', notes='x' * 60000)
        client.post('/api/sync', {'cursor': 0, 'changes': [current]})
        # Each copy fits on its own, but together they would pass MAX_PLAN_BYTES.
        res = client.post('/api/sync', {'cursor': 1, 'changes': [self.plan('m', other='y' * 60000)]})
        self.assertEqual(res['status'], 200)
        self.assertEqual(res['json']['cursor'], 1)
        data = res['json']['changes'][0]['data']
        self.assertEqual(data['notes'], current['data']['notes'])
        self.assertNotIn('other', data)

    def test_server_errors_do_not_leak_details(self):
        client = self.signed_in()
        with mock.patch.object(dayplan_api, 'api_sync', side_effect=RuntimeError('secret detail')):
            dayplan_api.ROUTES['/api/sync']['POST'] = dayplan_api.api_sync
            with mock.patch('sys.stderr', new=io.StringIO()):
                res = client.post('/api/sync', {'cursor': 0, 'changes': []})
        dayplan_api.ROUTES['/api/sync']['POST'] = dayplan_api.api_sync
        self.assertEqual(res['status'], 500)
        self.assertNotIn('secret', json.dumps(res['json']))


class Admin(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.admin = self.signed_in()
        self.friend = self.member('friend@example.com')
        # Members can't sync any more, but may still have plans saved before that.
        self.stored_directly('friend@example.com', self.plan('f1', 'Friend plan'))

    def act(self, action, email='friend@example.com', client=None):
        return (client or self.admin).post('/api/admin/users', {'email': email, 'action': action})

    def test_overview_lists_accounts_without_their_plans(self):
        res = self.admin.get('/api/admin/users')
        self.assertEqual(res['status'], 200)
        users = {u['email']: u for u in res['json']['users']}
        self.assertEqual(users[EMAIL]['admin'], True)
        self.assertEqual(users['friend@example.com']['status'], 'active')
        self.assertEqual(users['friend@example.com']['plans'], 1)
        self.assertNotIn('Friend plan', json.dumps(res['json']))  # counts only, never content
        self.assertTrue(res['json']['signup'])

    def test_only_the_admin_can_manage(self):
        self.assertEqual(self.friend.get('/api/admin/users')['status'], 403)
        self.assertEqual(self.act('disable', EMAIL, client=self.friend)['status'], 403)
        self.assertEqual(self.friend.post('/api/admin/settings', {'signup': False})['status'], 403)
        self.assertEqual(Client().get('/api/admin/users')['status'], 401)
        self.assertEqual(
            self.admin.post('/api/admin/users', {'email': 'friend@example.com', 'action': 'approve'},
                            origin='https://evil.example')['status'],
            403,
        )

    def test_disable_signs_out_and_blocks_sign_in(self):
        self.assertEqual(self.act('disable')['status'], 200)
        self.assertIsNone(self.friend.get('/api/me')['json']['user'])
        self.assertEqual(self.friend.post('/api/sync', {'cursor': 0, 'changes': []})['status'], 401)
        res = Client().post('/api/login', {'email': 'friend@example.com', 'password': PASSWORD})
        self.assertEqual(res['status'], 403)
        self.assertIn('turned off', res['json']['error'])

        self.assertEqual(self.act('enable')['status'], 200)
        self.assertEqual(Client().post('/api/login', {'email': 'friend@example.com', 'password': PASSWORD})['status'], 200)

    def test_delete_removes_account_and_plans(self):
        res = self.act('delete')
        self.assertEqual(res['status'], 200)
        self.assertNotIn('friend@example.com', [u['email'] for u in res['json']['users']])
        conn = dayplan_api.connect()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM plans').fetchone()[0], 0)
        self.assertEqual(self.act('delete')['status'], 404)

    def test_admin_cannot_lock_themselves_out(self):
        for action in ('disable', 'delete'):
            self.assertEqual(self.act(action, EMAIL)['status'], 400)
        self.assertEqual(self.admin.get('/api/me')['json']['user']['admin'], True)

    def test_bad_admin_requests(self):
        self.assertEqual(self.act('promote')['status'], 400)
        self.assertEqual(self.admin.post('/api/admin/users', {'action': 'approve'})['status'], 400)
        self.assertEqual(self.admin.post('/api/admin/settings', {'signup': 'no'})['status'], 400)

    def test_stopping_sign_ups(self):
        res = self.admin.post('/api/admin/settings', {'signup': False})
        self.assertFalse(res['json']['signup'])
        self.assertFalse(Client().get('/api/me')['json']['signup'])
        res = Client().post('/api/register', {'email': 'new@example.com', 'password': PASSWORD})
        self.assertEqual(res['status'], 403)
        self.admin.post('/api/admin/settings', {'signup': True})
        res = Client().post('/api/register', {'email': 'new@example.com', 'password': PASSWORD})
        self.assertEqual(res['status'], 202)

    def test_waiting_list_is_capped(self):
        with mock.patch.object(dayplan_api, 'MAX_PENDING', 2):
            for i in range(2):
                self.assertEqual(Client().post('/api/register', {'email': f'p{i}@example.com', 'password': PASSWORD})['status'], 202)
            self.assertEqual(Client().post('/api/register', {'email': 'p9@example.com', 'password': PASSWORD})['status'], 429)
            self.act('delete', 'p0@example.com')  # declining frees a place
            self.assertEqual(Client().post('/api/register', {'email': 'p9@example.com', 'password': PASSWORD})['status'], 202)


class Viewers(ApiTestCase):
    """Approved accounts that aren't the admin only view the admin's meetings."""

    def setUp(self):
        super().setUp()
        self.admin = self.signed_in()
        self.interview = self.plan(
            'm-late', 'Final round', kind='meeting', company='Acme', description='Bring the portfolio.',
            dueDate='2026-10-20', dueTime='15:00', status='todo', priority='high', tags=['interview'],
            checklist=[{'id': 'c1', 'text': 'Research Acme', 'done': True}],
            meetingUrl='https://example.com/j/1', jobUrl='https://example.com/jobs/1',
            createdAt=stamp(), startedAt='', completedAt='',
            order=3, secret='Salary I would accept',  # stored, but never shared
        )
        res = self.admin.post('/api/sync', {'cursor': 0, 'changes': [
            self.interview,
            self.plan('m-early', 'Phone screen', kind='meeting', dueDate='2026-10-16', dueTime='09:30'),
            self.plan('m-untimed', 'Prep call', kind='meeting', dueDate='2026-10-16'),
            self.plan('m-undated', 'Coffee chat', kind='meeting', dueDate=''),
            self.plan('p-plain', 'Buy groceries'),
            self.plan('p-plan', 'Update CV', kind='plan', dueDate='2026-10-16'),
            self.plan('m-gone', 'Cancelled call', kind='meeting', dueDate='2026-10-18'),
        ]})
        self.assertEqual(res['status'], 200)
        self.assertEqual(self.admin.post('/api/sync', {'cursor': 7, 'changes': [self.deleted('m-gone')]})['status'], 200)
        self.friend = self.member('friend@example.com')
        self.stored_directly(
            'friend@example.com',
            self.plan('f-plan', 'Friend plan'),
            self.plan('f-meeting', 'Friend meeting', kind='meeting', dueDate='2026-10-17'),
        )

    def schedule(self, client):
        res = client.get('/api/schedule')
        self.assertEqual(res['status'], 200, res['json'])
        self.assertEqual(list(res['json']), ['meetings'])
        return res['json']['meetings']

    def test_a_member_cannot_sync(self):
        before = self.plans_of('friend@example.com')
        for body in [
            {'cursor': 0, 'changes': []},
            {'cursor': 0, 'full': True, 'changes': []},
            {'cursor': 0, 'changes': [self.plan('new', 'My own plan')]},
            # Same ids as the admin's meetings: still only the member's own storage, and still refused.
            {'cursor': 0, 'changes': [self.plan('m-late', 'Hijacked', kind='meeting'), self.deleted('m-early')]},
        ]:
            res = self.friend.post('/api/sync', body)
            self.assertEqual(res['status'], 403, body)
            # Nothing read either: the answer is the error alone, without the member's old plans.
            self.assertEqual(res['json'], {'error': 'This account can view the meeting schedule but not change it.'})
        self.assertEqual(self.plans_of('friend@example.com'), before)
        titles = {m['id']: m['title'] for m in self.schedule(self.admin)}
        self.assertEqual(titles['m-late'], 'Final round')
        self.assertIn('m-early', titles)

    def test_schedule_shares_only_the_admins_meetings(self):
        meetings = self.schedule(self.friend)
        # Soonest first (untimed last in their day, undated at the end). Not the admin's
        # other plans, not a deleted meeting, not the member's own old plans or meetings.
        self.assertEqual([m['id'] for m in meetings], ['m-early', 'm-untimed', 'm-late', 'm-undated'])
        allowed = set(dayplan_api.SCHEDULE_FIELDS) | {'id'}
        for meeting in meetings:
            self.assertLessEqual(set(meeting), allowed)
        # Every listed field is shared; anything else stored with the meeting is not.
        shared = {k: v for k, v in self.interview['data'].items() if k not in ('order', 'secret')}
        self.assertEqual(meetings[2], shared)
        self.assertNotIn('Salary', json.dumps(meetings))
        # Fields a meeting doesn't have are simply absent.
        self.assertEqual(set(meetings[0]), {'id', 'kind', 'title', 'dueDate', 'dueTime', 'updatedAt'})

    def test_meetings_of_a_disabled_admin_are_not_shared(self):
        boss = self.member('boss@example.com', admin=True)
        meeting = self.plan('b1', 'Board meeting', kind='meeting', dueDate='2026-10-15')
        self.assertEqual(boss.post('/api/sync', {'cursor': 0, 'changes': [meeting]})['status'], 200)
        self.assertEqual(self.schedule(self.friend)[0]['title'], 'Board meeting')  # every admin's meetings
        res = self.admin.post('/api/admin/users', {'email': 'boss@example.com', 'action': 'disable'})
        self.assertEqual(res['status'], 200)
        self.assertNotIn('b1', [m['id'] for m in self.schedule(self.friend)])

    def test_unreadable_rows_are_skipped(self):
        odd = self.plan('m-odd', 'Odd dates', kind='meeting', dueDate=5, dueTime=None)
        self.assertEqual(self.admin.post('/api/sync', {'cursor': 8, 'changes': [odd]})['status'], 200)
        conn = dayplan_api.connect()
        with conn:
            for plan_id, data in (('broken', '{not json'), ('list', '[1, 2]'), ('text', '"meeting"')):
                conn.execute(
                    "INSERT INTO plans (user_id, id, data, rev, updated_at) "
                    "SELECT id, ?, ?, 99, '' FROM users WHERE email = ?",
                    (plan_id, data, EMAIL),
                )
        conn.close()
        ids = [m['id'] for m in self.schedule(self.friend)]
        self.assertEqual(ids, ['m-early', 'm-untimed', 'm-late', 'm-odd', 'm-undated'])

    def test_needs_sign_in_and_works_for_the_admin(self):
        res = Client().get('/api/schedule')
        self.assertEqual(res['status'], 401)
        self.assertEqual(res['json'], {'error': 'Please sign in again.'})
        self.assertEqual(self.schedule(self.admin), self.schedule(self.friend))
        self.assertEqual(self.friend.post('/api/schedule', {})['status'], 405)

    def test_pending_and_disabled_accounts_cannot_read_it(self):
        waiting = Client()
        waiting.post('/api/register', {'email': 'waiting@example.com', 'password': PASSWORD})
        self.assertEqual(waiting.post('/api/login', {'email': 'waiting@example.com', 'password': PASSWORD})['status'], 401)
        self.assertEqual(waiting.get('/api/schedule')['status'], 401)
        # Even a session of its own counts for nothing until the account is approved.
        conn = dayplan_api.connect()
        user_id = conn.execute("SELECT id FROM users WHERE email = 'waiting@example.com'").fetchone()[0]
        waiting.cookie = 'dayplan_session=' + dayplan_api.create_session(conn, user_id)
        conn.close()
        self.assertEqual(waiting.get('/api/schedule')['status'], 401)

        # Once approved, it sees the meetings, and still can't plan.
        self.admin.post('/api/admin/users', {'email': 'waiting@example.com', 'action': 'approve'})
        self.assertEqual(len(self.schedule(waiting)), 4)
        self.assertEqual(waiting.post('/api/sync', {'cursor': 0, 'changes': []})['status'], 403)

        self.admin.post('/api/admin/users', {'email': 'friend@example.com', 'action': 'disable'})
        self.assertEqual(self.friend.get('/api/schedule')['status'], 401)
        self.assertEqual(Client().post('/api/login', {'email': 'friend@example.com', 'password': PASSWORD})['status'], 403)


class Files(ApiTestCase):
    """PDFs (a resume, a cover letter) attached to the admin's meetings."""

    def setUp(self):
        super().setUp()
        self.admin = self.signed_in()
        self.friend = self.member('friend@example.com')

    def uploaded(self, client=None, data=PDF, name='resume.pdf'):
        res = (client or self.admin).upload(data, name)
        self.assertEqual(res['status'], 201, res['json'])
        return res['json']

    def save(self, *changes, client=None):
        res = (client or self.admin).post('/api/sync', {'cursor': 0, 'changes': list(changes)})
        self.assertEqual(res['status'], 200, res['json'])

    def meeting(self, plan_id='m1', resume=None, cover_letter=None, **fields):
        fields = {'kind': 'meeting', 'dueDate': '2026-10-20', 'dueTime': '15:00', **fields}
        return self.plan(plan_id, 'Interview', resume=resume, coverLetter=cover_letter, **fields)

    def file_ids(self, email=None):
        conn = dayplan_api.connect()
        sql = 'SELECT files.id FROM files JOIN users ON users.id = files.user_id'
        rows = conn.execute(sql + ' WHERE users.email = ?', (email,)) if email else conn.execute(sql)
        ids = {row[0] for row in rows}
        conn.close()
        return ids

    def stored_file(self, email, name='old.pdf'):
        """Puts a file straight into an account's storage (e.g. a viewer's, which can't upload)."""
        file_id = dayplan_api.secrets.token_hex(16)
        conn = dayplan_api.connect()
        with conn:
            conn.execute(
                'INSERT INTO files (id, user_id, name, size, data, created_at) '
                'SELECT ?, id, ?, ?, ?, ? FROM users WHERE email = ?',
                (file_id, name, len(PDF), PDF, int(time.time()), email),
            )
        conn.close()
        return file_id

    def test_the_admin_uploads_a_pdf(self):
        res = self.admin.upload(PDF, 'My Resume.pdf')
        self.assertEqual(res['status'], 201)
        doc = res['json']
        self.assertEqual(set(doc), {'id', 'name', 'size'})
        self.assertRegex(doc['id'], r'^[0-9a-f]{32}$')
        self.assertEqual((doc['name'], doc['size']), ('My Resume.pdf', len(PDF)))
        conn = dayplan_api.connect()
        row = conn.execute('SELECT name, size, data FROM files WHERE id = ?', (doc['id'],)).fetchone()
        conn.close()
        self.assertEqual((row['name'], row['size'], bytes(row['data'])), ('My Resume.pdf', len(PDF), PDF))
        self.assertNotEqual(self.uploaded()['id'], doc['id'])  # every upload is a new file

    def test_only_a_signed_in_admin_uploads(self):
        res = self.friend.upload()
        self.assertEqual(res['status'], 403)
        self.assertEqual(res['json'], {'error': 'This account can view the meeting schedule but not change it.'})
        self.assertEqual(Client().upload()['status'], 401)
        self.assertEqual(self.file_ids(), set())

    def test_only_pdfs_from_this_site(self):
        for content_type in ('application/octet-stream', 'text/plain', 'application/json', 'multipart/form-data'):
            res = self.admin.post('/api/files', PDF, content_type=content_type)
            self.assertEqual(res['status'], 415, content_type)
        # ...and the JSON endpoints still only take JSON.
        self.assertEqual(self.admin.post('/api/sync', PDF, content_type='application/pdf')['status'], 415)

        res = self.admin.upload(origin='https://evil.example')
        self.assertEqual(res['status'], 403)
        self.assertEqual(res['json'], {'error': 'Cross-site request blocked.'})
        self.assertEqual(self.file_ids(), set())
        # Like the other requests, one that doesn't say where it comes from isn't from another site's page.
        self.assertEqual(self.admin.upload(origin=None)['status'], 201)

    def test_files_that_are_not_pdfs_are_refused(self):
        for data in (b'<html><script>alert(1)</script></html>', b'', b'%PDF', b' %PDF-1.7'):
            res = self.admin.upload(data)
            self.assertEqual(res['status'], 400, data)
            self.assertEqual(res['json'], {'error': 'This file is not a PDF.'})
        self.assertEqual(self.file_ids(), set())

    def test_size_limit(self):
        with mock.patch.object(dayplan_api, 'MAX_FILE_BYTES', 200):
            res = self.admin.upload(PDF + b'x' * (201 - len(PDF)))
            self.assertEqual(res['status'], 413)
            self.assertIn('PDF files can be up to', res['json']['error'])
            self.assertEqual(self.admin.upload(PDF + b'x' * (200 - len(PDF)))['status'], 201)
        self.assertEqual(dayplan_api.MAX_FILE_BYTES, 10 * 1024 * 1024)
        # Uploads may be larger than any other request; those keep their own limit.
        with mock.patch.object(dayplan_api, 'MAX_BODY_BYTES', 10):
            self.assertEqual(self.admin.upload()['status'], 201)
            self.assertEqual(self.admin.post('/api/sync', {'cursor': 0, 'changes': []})['status'], 413)

    def test_limits_per_account(self):
        with mock.patch.object(dayplan_api, 'MAX_FILES', 2):
            self.uploaded()
            self.uploaded()
            res = self.admin.upload()
            self.assertEqual(res['status'], 413)
            self.assertIn('2 files', res['json']['error'])
            # Each account has its own allowance.
            boss = self.member('boss@example.com', admin=True)
            self.uploaded(boss)
        self.assertEqual(len(self.file_ids(EMAIL)), 2)

        with mock.patch.object(dayplan_api, 'MAX_ACCOUNT_FILE_BYTES', 4 * len(PDF)):
            self.uploaded(boss, PDF + b'x' * len(PDF))  # 3 PDFs' worth with the first one: room for 1 more
            self.uploaded(boss)
            res = boss.upload()
            self.assertEqual(res['status'], 413)
            self.assertIn('no room', res['json']['error'])
        self.assertEqual(len(self.file_ids('boss@example.com')), 3)

    def test_file_names_are_cleaned(self):
        clean = dayplan_api.clean_file_name
        for raw, expected in [
            ('resume.pdf', 'resume.pdf'),
            ('C:\\Users\\me\\Cover letter.PDF', 'Cover letter.PDF'),
            ('../../etc/passwd', 'passwd.pdf'),
            ('My "best" CV\'s.pdf', 'My best CVs.pdf'),
            ('line\r\nbreak\x00\t\x7f.pdf', 'linebreak.pdf'),
            ('invoice\u202efdp.exe', 'invoicefdp.exe.pdf'),  # no right-to-left trick
            ('Résumé – 2026 ✓.pdf', 'Résumé – 2026 ✓.pdf'),
            ('  spaced out .pdf  ', 'spaced out.pdf'),
            ('notes.txt', 'notes.txt.pdf'),
            ('', 'document.pdf'),
            ('   ', 'document.pdf'),
            ('.pdf', 'document.pdf'),
            ('folder/', 'document.pdf'),
            ('"\'', 'document.pdf'),
        ]:
            self.assertEqual(clean(quote(raw, safe='')), expected, raw)
        self.assertEqual(clean(None), 'document.pdf')
        self.assertEqual(clean('a' * 300 + '.pdf'), 'a' * 116 + '.pdf')
        self.assertEqual(clean('b' * 300), 'b' * 116 + '.pdf')
        self.assertTrue(clean('%E2%28%A1%ZZ.pdf').endswith('.pdf'))  # broken encoding is harmless
        # The same through the API, with or without a name.
        self.assertEqual(self.uploaded(name='C:\\fakepath\\Lebenslauf "final".pdf')['name'], 'Lebenslauf final.pdf')
        self.assertEqual(self.uploaded(name=None)['name'], 'document.pdf')

    def test_the_owner_downloads_with_safe_headers(self):
        doc = self.uploaded(name='Résumé "2026".pdf')
        self.assertEqual(doc['name'], 'Résumé 2026.pdf')
        path = '/api/files/' + doc['id']
        res = self.admin.get(path)
        self.assertEqual(res['status'], 200)
        self.assertEqual(res['body'], PDF)
        headers = dict(res['headers'])
        self.assertEqual(len(headers), len(res['headers']))  # each header once (the JSON default is replaced)
        self.assertEqual(headers['Content-Type'], 'application/pdf')
        self.assertEqual(headers['Content-Length'], str(len(PDF)))
        self.assertEqual(
            headers['Content-Disposition'],
            'inline; filename="Resume 2026.pdf"; filename*=UTF-8\'\'R%C3%A9sum%C3%A9%202026.pdf',
        )
        self.assertEqual(headers['Cache-Control'], 'private, no-store')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')

        head = self.admin.request('HEAD', path)
        self.assertEqual(head['status'], 200)
        self.assertEqual(head['body'], b'')
        self.assertEqual(dict(head['headers'])['Content-Length'], str(len(PDF)))

        # A name with no plain-ASCII letters still gets a usable stand-in.
        other = self.uploaded(name='履歴書.pdf')
        disposition = dict(self.admin.get('/api/files/' + other['id'])['headers'])['Content-Disposition']
        self.assertEqual(disposition, 'inline; filename="document.pdf"; filename*=UTF-8\'\'%E5%B1%A5%E6%AD%B4%E6%9B%B8.pdf')

    def test_viewers_open_a_file_only_while_a_meeting_has_it(self):
        resume = self.uploaded(name='resume.pdf')
        letter = self.uploaded(name='letter.pdf')

        def opens(doc, client=None):
            res = (client or self.friend).get('/api/files/' + doc['id'])
            if res['status'] == 404:
                self.assertEqual(res['json'], {'error': 'Not found.'})  # the same as a file that doesn't exist
                return False
            self.assertEqual((res['status'], res['body']), (200, PDF))
            return True

        self.assertFalse(opens(resume))  # uploaded, but not on a meeting yet
        self.save(self.meeting(resume=resume, cover_letter=letter))
        self.assertTrue(opens(resume))
        self.assertTrue(opens(letter))

        # Turned into a plain plan: not shared any more (the owner can still open it).
        self.save(self.meeting(resume=resume, cover_letter=letter, kind='plan'))
        self.assertFalse(opens(resume))
        self.assertFalse(opens(letter))
        self.assertTrue(opens(resume, self.admin))

        # The resume taken off the meeting; its id mentioned elsewhere doesn't count.
        self.save(self.meeting(resume=None, cover_letter=letter, description='Old resume: ' + resume['id']))
        self.assertFalse(opens(resume))
        self.assertTrue(opens(letter))

        self.save(self.deleted('m1'))
        self.assertFalse(opens(letter))
        self.assertTrue(opens(letter, self.admin))

    def test_everyone_else_gets_not_found(self):
        mine = self.uploaded()
        boss = self.member('boss@example.com', admin=True)
        theirs = self.uploaded(boss)
        for client in (self.admin, self.friend):
            for path in [
                '/api/files/' + '0' * 32,  # no such file
                '/api/files/' + mine['id'].upper(),
                '/api/files/' + mine['id'][:-1],
                '/api/files/' + mine['id'] + '/x',
                '/api/files/' + mine['id'] + '.pdf',
                '/api/files/' + theirs['id'],  # another admin's file that no meeting has
            ]:
                res = client.get(path)
                self.assertEqual((res['status'], res['json']), (404, {'error': 'Not found.'}), path)
        self.assertEqual(boss.get('/api/files/' + theirs['id'])['status'], 200)

        # Another admin's meeting can't share my file: only the owner's meetings count.
        self.save(self.meeting('b1', resume=mine), client=boss)
        self.assertEqual(self.friend.get('/api/files/' + mine['id'])['status'], 404)

        # A viewer's own file (stored before viewers became view-only) stays theirs alone.
        old = self.stored_file('friend@example.com')
        self.assertEqual(self.friend.get('/api/files/' + old)['status'], 200)
        self.assertEqual(self.admin.get('/api/files/' + old)['status'], 404)
        self.assertEqual(self.member('other@example.com').get('/api/files/' + old)['status'], 404)

        # Signed out: asked to sign in, whether or not the file exists.
        for path in ('/api/files/' + mine['id'], '/api/files/' + '0' * 32):
            res = Client().get(path)
            self.assertEqual((res['status'], res['json']), (401, {'error': 'Please sign in again.'}))

        # Only the methods each path has.
        res = self.admin.get('/api/files')
        self.assertEqual((res['status'], dict(res['headers'])['Allow']), (405, 'POST'))
        res = self.admin.post('/api/files/' + mine['id'], {})
        self.assertEqual((res['status'], dict(res['headers'])['Allow']), (405, 'GET, HEAD'))

    def test_files_of_a_disabled_admin_are_not_shared(self):
        boss = self.member('boss@example.com', admin=True)
        doc = self.uploaded(boss)
        self.save(self.meeting('b1', resume=doc), client=boss)
        self.assertEqual(self.friend.get('/api/files/' + doc['id'])['status'], 200)
        self.admin.post('/api/admin/users', {'email': 'boss@example.com', 'action': 'disable'})
        self.assertEqual(self.friend.get('/api/files/' + doc['id'])['status'], 404)

    def test_old_files_no_plan_uses_are_cleared(self):
        now = time.time()
        on_meeting = self.uploaded(name='on-meeting.pdf')
        in_plan = self.uploaded(name='in-plan.pdf')
        replaced = self.uploaded(name='replaced.pdf')
        deleted_with_meeting = self.uploaded(name='deleted.pdf')
        boss = self.member('boss@example.com', admin=True)
        boss_unused = self.uploaded(boss)
        self.save(self.meeting('m1', resume=replaced), self.meeting('m2', resume=deleted_with_meeting))
        self.save(
            self.meeting('m1', resume=on_meeting),  # a new resume replaces the first one
            self.plan('p1', 'Follow up', description='See ' + in_plan['id']),
            self.deleted('m2'),
        )

        # 23 hours later: too soon to clear anything (a plan may not have been synced yet).
        with mock.patch('time.time', return_value=now + 23 * 3600):
            recent = self.uploaded(name='recent.pdf')
        self.assertEqual(len(self.file_ids(EMAIL)), 5)

        # A day later, the next upload notes which files no live plan mentions; nothing is deleted yet.
        day = now + dayplan_api.UNUSED_FILE_SECONDS + 60
        with mock.patch('time.time', return_value=day):
            newest = self.uploaded(name='newest.pdf')
        self.assertEqual(len(self.file_ids(EMAIL)), 6)

        # The deleted meeting comes back (undo, a backup): its resume is in use again.
        self.save(self.meeting('m2', resume=deleted_with_meeting, at=stamp()))

        # 30 days after that, the next upload clears what is still unused.
        with mock.patch('time.time', return_value=day + dayplan_api.KEEP_UNUSED_SECONDS + 60):
            last = self.uploaded(name='last.pdf')
        self.assertEqual(
            self.file_ids(EMAIL),
            {on_meeting['id'], in_plan['id'], recent['id'], newest['id'], deleted_with_meeting['id'], last['id']},
        )
        self.assertNotIn(replaced['id'], self.file_ids())
        self.assertEqual(self.admin.get('/api/files/' + replaced['id'])['status'], 404)
        self.assertEqual(self.admin.get('/api/files/' + deleted_with_meeting['id'])['status'], 200)
        # Other accounts' files are left alone.
        self.assertEqual(self.file_ids('boss@example.com'), {boss_unused['id']})

    def test_deleting_an_account_deletes_its_files(self):
        boss = self.member('boss@example.com', admin=True)
        self.uploaded(boss)
        self.uploaded(boss)
        mine = self.uploaded()
        res = self.admin.post('/api/admin/users', {'email': 'boss@example.com', 'action': 'delete'})
        self.assertEqual(res['status'], 200)
        self.assertEqual(self.file_ids(), {mine['id']})

    def test_schedule_shares_time_zone_end_time_and_documents(self):
        resume = self.uploaded(name='resume.pdf')
        letter = self.uploaded(name='letter.pdf')
        self.save(self.meeting(resume=resume, cover_letter=letter, timeZone='America/New_York', endTime='16:00'))
        self.save(self.meeting('m2'))  # no documents
        meetings = {m['id']: m for m in self.friend.get('/api/schedule')['json']['meetings']}
        shared = meetings['m1']
        self.assertEqual(shared['timeZone'], 'America/New_York')
        self.assertEqual(shared['endTime'], '16:00')
        self.assertEqual(shared['resume'], resume)
        self.assertEqual(shared['coverLetter'], letter)
        self.assertIsNone(meetings['m2']['resume'])
        # The links the viewer gets work for them.
        for doc in (resume, letter):
            self.assertEqual(self.friend.get('/api/files/' + doc['id'])['status'], 200)


class Upgrade(ApiTestCase):
    def test_database_from_before_approvals(self):
        """A site whose owner signed up before approvals existed keeps working, owner becomes admin."""
        import sqlite3
        path = Path(os.environ['DAYPLAN_DB'])
        path.parent.mkdir(parents=True)
        old = sqlite3.connect(str(path))
        old.executescript('''
            CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
                                rev INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
            CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
            CREATE TABLE plans (user_id INTEGER NOT NULL, id TEXT NOT NULL, data TEXT, rev INTEGER NOT NULL,
                                PRIMARY KEY (user_id, id));
            CREATE TABLE login_failures (email TEXT NOT NULL, at INTEGER NOT NULL);
        ''')
        old.execute('INSERT INTO plans VALUES (1, ?, ?, 1)',
                    ('p1', json.dumps({'id': 'p1', 'title': 'Old plan', 'updatedAt': '2026-10-01T08:00:00.000Z'})))
        old.execute("INSERT INTO plans VALUES (1, 'gone', NULL, 2)")  # deleted before the upgrade
        old.execute('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, 1)',
                    (EMAIL, dayplan_api.hash_password(PASSWORD)))
        old.execute('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, 2)',
                    ('second@example.com', dayplan_api.hash_password(PASSWORD)))
        old.commit()
        old.close()

        owner = Client()
        res = owner.post('/api/login', {'email': EMAIL, 'password': PASSWORD})
        self.assertEqual(res['status'], 200)
        self.assertEqual(res['json']['user'], public(EMAIL, admin=True))
        second = Client()
        res = second.post('/api/login', {'email': 'second@example.com', 'password': PASSWORD})
        self.assertEqual(res['json']['user'], public('second@example.com', admin=False))
        dayplan_api.connect()  # running the upgrade again changes nothing
        self.assertEqual(owner.get('/api/admin/users')['status'], 200)
        # Old plans got their times, so an older copy can't overwrite them.
        res = owner.post('/api/sync', {'cursor': 0, 'changes': [self.plan('p1', 'Stale', at='2026-09-01T00:00:00.000Z')]})
        self.assertEqual({c['id']: c['data']['title'] if c['data'] else None for c in res['json']['changes']}['p1'], 'Old plan')
        # A plan deleted before the upgrade stays deleted when an old copy is offered.
        res = owner.post('/api/sync', {'cursor': 0, 'changes': [self.plan('gone', 'Back?', at=dayplan_api.server_stamp(-60_000))]})
        self.assertIsNone({c['id']: c['data'] for c in res['json']['changes']}['gone'])
        # The database got a place for uploaded files too.
        doc = owner.upload()['json']
        self.assertEqual(owner.get('/api/files/' + doc['id'])['body'], PDF)
        # ...and for meeting emails, which everyone gets until they turn them off.
        self.assertEqual(owner.get('/api/me')['json']['mail'], {'ready': False, 'sender': '', 'recipients': 1, 'viewers': 1})
        dayplan_mail.save_config(dayplan_api.mail_config_path(), {'username': SENDER, 'password': APP_PASSWORD})
        meeting = self.plan('m1', 'Interview', kind='meeting', dueDate='2026-10-22')
        self.assertEqual(owner.post('/api/sync', {'cursor': 0, 'changes': [meeting]})['status'], 200)
        res = owner.post('/api/notify', {'id': 'm1'})
        self.assertEqual(res['json'], {'sent': 1, 'failed': 0, 'recipients': 1, 'kind': 'new'})
        self.assertEqual(self.gmail.to(), ['second@example.com'])
        res = second.post('/api/account', {'notify': False, 'timeZone': 'UTC'})
        self.assertEqual(res['json']['user'], public('second@example.com', notify=False, zone='UTC'))

    def test_database_from_before_meeting_emails(self):
        """Accounts get the email settings (on, no time zone yet); nothing else changes."""
        path = Path(os.environ['DAYPLAN_DB'])
        path.parent.mkdir(parents=True)
        old = sqlite3.connect(str(path))
        old.executescript('''
            CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
                                rev INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
                                status TEXT NOT NULL DEFAULT 'active', is_admin INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id)
                                   ON DELETE CASCADE, expires_at INTEGER NOT NULL);
            CREATE TABLE plans (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL,
                                data TEXT, rev INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT '',
                                PRIMARY KEY (user_id, id));
        ''')
        for email, status, admin in ((EMAIL, 'active', 1), ('viewer@example.com', 'active', 0),
                                     ('waiting@example.com', 'pending', 0)):
            old.execute(
                'INSERT INTO users (email, password_hash, created_at, status, is_admin) VALUES (?, ?, 1, ?, ?)',
                (email, dayplan_api.hash_password(PASSWORD), status, admin),
            )
        old.commit()
        old.close()

        conn = dayplan_api.connect()
        rows = conn.execute('SELECT email, status, is_admin, notify, time_zone FROM users ORDER BY id').fetchall()
        self.assertEqual([tuple(row) for row in rows], [
            (EMAIL, 'active', 1, 1, ''),
            ('viewer@example.com', 'active', 0, 1, ''),
            ('waiting@example.com', 'pending', 0, 1, ''),
        ])
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertLessEqual({'notices', 'mail_log'}, tables)
        conn.close()
        dayplan_api.connect().close()  # running the upgrade again changes nothing

        viewer = Client()
        res = viewer.post('/api/login', {'email': 'viewer@example.com', 'password': PASSWORD})
        self.assertEqual(res['json']['user'], public('viewer@example.com'))
        owner = Client()
        owner.post('/api/login', {'email': EMAIL, 'password': PASSWORD})
        self.assertEqual(owner.get('/api/me')['json']['mail']['recipients'], 1)


class CommandLine(ApiTestCase):
    def test_set_password_and_list_users(self):
        with mock.patch('sys.stdout', new=io.StringIO()) as out:
            # A typo must not quietly create an account.
            self.assertEqual(dayplan_api.main(['x', 'set-password', 'New@Example.com']), 1)
        self.assertIn('No account', out.getvalue())
        with mock.patch('getpass.getpass', side_effect=[PASSWORD, PASSWORD]), mock.patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(dayplan_api.main(['x', 'add-user', 'New@Example.com']), 0)
        with mock.patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(dayplan_api.main(['x', 'add-user', 'new@example.com']), 1)  # already exists
        with mock.patch('sys.stdout', new=io.StringIO()) as out:
            dayplan_api.main(['x', 'list-users'])
        self.assertIn('new@example.com', out.getvalue())
        self.assertIn('(admin)', out.getvalue())  # first account made from the console is the admin
        with mock.patch('getpass.getpass', side_effect=[PASSWORD, 'different']), mock.patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(dayplan_api.main(['x', 'set-password', 'new@example.com']), 1)
        with mock.patch('getpass.getpass', side_effect=['another password', 'another password']), mock.patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(dayplan_api.main(['x', 'set-password', 'new@example.com']), 0)
        self.assertEqual(Client().post('/api/login', {'email': 'new@example.com', 'password': 'another password'})['status'], 200)
        dayplan_api.set_password(dayplan_api.connect(), 'new@example.com', PASSWORD)
        self.assertEqual(Client().post('/api/login', {'email': 'new@example.com', 'password': PASSWORD})['status'], 200)


class CommandLineApprovals(ApiTestCase):
    def test_approve_and_make_admin(self):
        self.signed_in()
        Client().post('/api/register', {'email': 'waiting@example.com', 'password': PASSWORD})
        with mock.patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(dayplan_api.main(['x', 'approve', 'Waiting@Example.com']), 0)
            self.assertEqual(dayplan_api.main(['x', 'approve', 'nobody@example.com']), 1)
            self.assertEqual(dayplan_api.main(['x', 'make-admin', 'waiting@example.com']), 0)
        res = Client().post('/api/login', {'email': 'waiting@example.com', 'password': PASSWORD})
        self.assertEqual(res['json']['user'], public('waiting@example.com', admin=True))


class CommandLineRecovery(ApiTestCase):
    def test_make_admin_creates_a_missing_account(self):
        # A stranger grabbed the site and turned sign-ups off; the owner has no account.
        self.signed_in('stranger@example.com')
        with mock.patch('getpass.getpass', side_effect=[PASSWORD, PASSWORD]), mock.patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(dayplan_api.main(['x', 'make-admin', 'owner@example.com']), 0)
        res = Client().post('/api/login', {'email': 'owner@example.com', 'password': PASSWORD})
        self.assertEqual(res['json']['user'], public('owner@example.com', admin=True))

    def test_new_epoch(self):
        client = self.signed_in()
        epoch = client.post('/api/sync', {'cursor': 0, 'changes': []})['json']['epoch']
        with mock.patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(dayplan_api.main(['x', 'new-epoch']), 0)
        res = client.post('/api/sync', {'epoch': epoch, 'cursor': 0, 'changes': []})['json']
        self.assertTrue(res['reset'])


class MeetingEmails(ApiTestCase):
    """The admin emails approved accounts about a meeting (POST /api/notify)."""

    def setUp(self):
        super().setUp()
        self.admin = self.signed_in()
        self.friend = self.member('friend@example.com')
        self.zoe = self.member('zoe@example.com')
        dayplan_mail.save_config(dayplan_api.mail_config_path(), {'username': SENDER, 'password': APP_PASSWORD})
        # Every answer in these tests is checked for the app password.
        request = Client.request

        def checked(client, *args, **kwargs):
            res = request(client, *args, **kwargs)
            self.assertNotIn(APP_PASSWORD.encode(), res['body'])
            return res

        patch = mock.patch.object(Client, 'request', checked)
        patch.start()
        self.addCleanup(patch.stop)

    def meeting(self, plan_id='m1', at=None, **fields):
        """Thu, Oct 22, 2026, 2-3 PM in New York, with notes that never go in an email."""
        fields = {
            'kind': 'meeting', 'company': 'Acme', 'dueDate': '2026-10-22', 'dueTime': '14:00', 'endTime': '15:00',
            'timeZone': 'America/New_York', 'meetingUrl': 'https://zoom.us/j/123', 'description': 'Private notes',
            **fields,
        }
        return self.plan(plan_id, 'Interview with Acme', at=at, **fields)

    def save(self, *changes, client=None):
        res = (client or self.admin).post('/api/sync', {'cursor': 0, 'changes': list(changes)})
        self.assertEqual(res['status'], 200, res['json'])

    def notify(self, plan_id='m1', status=200, client=None, **body):
        res = (client or self.admin).post('/api/notify', {'id': plan_id, **body})
        self.assertEqual(res['status'], status, res['json'])
        return res['json']

    def notice(self, plan_id='m1'):
        """What people were last emailed about a meeting: (snapshot, sequence, cancelled), or None."""
        conn = dayplan_api.connect()
        row = conn.execute('SELECT snapshot, sequence, cancelled FROM notices WHERE plan_id = ?', (plan_id,)).fetchone()
        conn.close()
        return None if row is None else (json.loads(row['snapshot']), row['sequence'], row['cancelled'])

    def mail_log(self):
        conn = dayplan_api.connect()
        rows = [tuple(row) for row in conn.execute('SELECT at, recipients FROM mail_log ORDER BY rowid')]
        conn.close()
        return rows

    def age_mail_log(self, seconds):
        conn = dayplan_api.connect()
        with conn:
            conn.execute('UPDATE mail_log SET at = at - ?', (seconds,))
        conn.close()

    def last(self):
        return self.gmail.messages[-1]

    def test_only_the_admin_sends_them(self):
        self.save(self.meeting())
        res = self.friend.post('/api/notify', {'id': 'm1'})
        self.assertEqual((res['status'], res['json']), (403, {'error': 'Only the admin can do that.'}))
        self.assertEqual(Client().post('/api/notify', {'id': 'm1'})['status'], 401)
        self.assertEqual(self.admin.post('/api/notify', {'id': 'm1'}, origin='https://evil.example')['status'], 403)
        res = self.admin.get('/api/notify')
        self.assertEqual((res['status'], dict(res['headers'])['Allow']), (405, 'POST'))
        self.assertEqual(self.gmail.connections, [])
        self.assertIsNone(self.notice())

    def test_email_must_be_set_up(self):
        dayplan_mail.delete_config(dayplan_api.mail_config_path())
        self.save(self.meeting())
        res = self.notify(status=409)
        self.assertTrue(res['notConfigured'])
        self.assertIn('setup-email', res['error'])
        self.assertEqual(self.gmail.connections, [])
        # Set up from a console: it works straight away, without a reload.
        dayplan_mail.save_config(dayplan_api.mail_config_path(), {'username': SENDER, 'password': APP_PASSWORD})
        self.assertEqual(self.notify()['sent'], 2)

    def test_the_change_must_reach_the_server_first(self):
        meeting = self.meeting()
        self.save(meeting)
        res = self.notify(updatedAt=stamp(), status=409)
        self.assertEqual(res, {'error': "This change hasn't reached the server yet.", 'notSaved': True})
        self.assertEqual(self.gmail.connections, [])
        self.assertEqual(self.notify(updatedAt=meeting['data']['updatedAt'])['sent'], 2)
        # An older version: another device saved a newer one, which is what's sent.
        self.assertEqual(self.notify(updatedAt=stamp(0))['sent'], 2)

    def test_only_saved_meetings(self):
        self.save(self.plan('p1', 'Update CV', kind='plan'), self.plan('p2', 'Old plan'), self.meeting('gone'))
        self.save(self.deleted('gone'))
        self.assertEqual(self.notify('nowhere', status=404)['error'], "This meeting isn't saved on the server yet.")
        self.assertEqual(self.notify('gone', status=409)['error'], 'This meeting was deleted.')
        self.notify('p1', status=400)
        self.notify('p2', status=400)  # from before meetings: no kind at all
        for body in [
            {}, {'id': 5}, {'id': ''}, {'id': 'x' * 101}, {'id': 'm1', 'cancel': 'yes'}, {'id': 'm1', 'cancel': None},
            {'id': 'm1', 'updatedAt': 'yesterday'}, {'id': 'm1', 'updatedAt': None},
        ]:
            self.assertEqual(self.admin.post('/api/notify', body)['status'], 400, body)
        self.assertEqual(self.gmail.connections, [])

    def test_who_gets_them(self):
        self.member('boss@example.com', admin=True)  # another admin plans: no emails
        self.assertEqual(self.member('quiet@example.com').post('/api/account', {'notify': False})['status'], 200)
        Client().post('/api/register', {'email': 'waiting@example.com', 'password': PASSWORD})  # not approved
        self.member('off@example.com')
        self.admin.post('/api/admin/users', {'email': 'off@example.com', 'action': 'disable'})
        self.save(self.meeting())

        self.assertEqual(self.notify(), {'sent': 2, 'failed': 0, 'recipients': 2, 'kind': 'new'})
        self.assertEqual(self.gmail.to(), ['friend@example.com', 'zoe@example.com'])
        self.assertEqual(self.gmail.connections, [('smtp.gmail.com', 587)])  # one connection for everyone
        self.assertEqual(self.gmail.logins, [(SENDER, APP_PASSWORD)])
        everyone = {EMAIL, 'friend@example.com', 'zoe@example.com', 'boss@example.com', 'quiet@example.com',
                    'waiting@example.com', 'off@example.com'}
        for msg in self.gmail.messages:
            # Each person gets their own email, and can't see who else got one.
            self.assertEqual(msg.get_all('To'), [msg['To']])
            self.assertIsNone(msg['Cc'])
            self.assertIsNone(msg['Bcc'])
            raw = msg.as_string()
            for other in everyone - {msg['To']}:
                self.assertNotIn(other, raw)
            self.assertIn(SENDER, msg['From'])
            self.assertNotIn(APP_PASSWORD, raw)
            content = text_of(msg) + html_of(msg)
            self.assertIn('https://dayplan.example.com/', content)  # the link back to the site
            self.assertIn('https://zoom.us/j/123', content)
            self.assertNotIn('Private notes', content)
            self.assertIn('UID:m1@dayplan', calendar_of(msg))

    def test_an_address_that_cannot_be_emailed_safely_is_skipped(self):
        # Accounts made from the console aren't checked as closely as sign-ups.
        conn = dayplan_api.connect()
        dayplan_api.set_password(conn, 'odd,one@example.com', PASSWORD)
        conn.close()
        self.save(self.meeting())
        self.assertEqual(self.notify(), {'sent': 2, 'failed': 1, 'recipients': 3, 'kind': 'new'})
        self.assertEqual(self.gmail.to(), ['friend@example.com', 'zoe@example.com'])

    def test_what_each_email_says_follows_what_people_were_told(self):
        first = self.meeting()
        self.save(first)
        self.assertEqual(self.notify(updatedAt=first['data']['updatedAt'])['kind'], 'new')
        self.assertEqual(self.notice()[1:], (0, 0))
        self.assertIn('SEQUENCE:0', calendar_of(self.last()))
        self.assertEqual(self.notify()['kind'], 'reminder')  # nothing new: the same details again
        # Notes, steps and tags aren't in the emails, so there's still nothing new to tell.
        self.save(self.meeting(description='New notes', tags=['prep']))
        self.assertEqual(self.notify()['kind'], 'reminder')

        # Moved by two hours: a change, with what it was before.
        self.save(self.meeting(dueTime='16:00', endTime='17:00'))
        self.assertEqual(self.notify()['kind'], 'changed')
        text = text_of(self.last())
        self.assertIn('What changed', text)
        self.assertIn('2:00', text)
        self.assertIn('4:00', text)
        self.assertIn('SEQUENCE:3', calendar_of(self.last()))
        self.assertEqual(self.notify()['kind'], 'reminder')

        # Deleted, and the deletion reached the server first: the cancellation
        # says what people were told last.
        self.save(self.deleted('m1'))
        self.assertEqual(self.notify(cancel=True)['kind'], 'cancelled')
        msg = self.last()
        self.assertIn('cancelled', msg['Subject'].lower())
        self.assertIn('Acme', msg['Subject'])
        self.assertIn('4:00', text_of(msg))
        self.assertIsNone(calendar_of(msg))
        snapshot, sequence, cancelled = self.notice()
        self.assertEqual((snapshot['dueTime'], sequence, cancelled), ('16:00', 5, 1))
        self.assertNotIn('description', snapshot)

        # Brought back (undo, say): it's back on.
        self.save(self.meeting(dueTime='16:00', endTime='17:00'))
        self.assertEqual(self.notify()['kind'], 'restored')
        self.assertEqual(self.notice()[1:], (6, 0))
        self.assertIn('SEQUENCE:6', calendar_of(self.last()))
        self.assertEqual(self.notify()['kind'], 'reminder')
        self.assertEqual(len(self.gmail.messages), 2 * 8)

    def test_cancelling(self):
        # Deleted before anyone was emailed about it: there's nobody to tell.
        self.save(self.meeting('m2'))
        self.save(self.deleted('m2'))
        res = self.notify('m2', cancel=True, status=409)
        self.assertIn('never emailed', res['error'])
        self.assertIsNone(self.notice('m2'))
        self.notify('nowhere', cancel=True, status=409)

        # Cancelled while the meeting is still saved: that's the one described.
        self.save(self.meeting('m3', company='Globex'))
        self.assertEqual(self.notify('m3', cancel=True)['kind'], 'cancelled')
        self.assertIn('Globex', self.last()['Subject'])
        self.assertEqual(self.notice('m3')[1:], (0, 1))

        # Turned into a plain plan after people were told: cancelled as they were told.
        self.save(self.meeting('m4', company='Initech'))
        self.notify('m4')
        self.save(self.meeting('m4', company='Initech', kind='plan'))
        self.notify('m4', status=400)
        self.assertEqual(self.notify('m4', cancel=True)['kind'], 'cancelled')
        self.assertIn('Initech', self.last()['Subject'])
        self.assertEqual(self.notice('m4')[1:], (1, 1))

    def test_gmail_problems(self):
        self.save(self.meeting())
        self.gmail.login_error = smtplib.SMTPAuthenticationError(535, b'5.7.8 Username and Password not accepted')
        with mock.patch('sys.stderr', new=io.StringIO()) as log:
            res = self.notify(status=502)
        self.assertIn('app password', res['error'])
        self.assertIn('setup-email', res['error'])
        self.assertIs(res['retry'], False)  # the app password has to be fixed first
        self.assertNotIn(APP_PASSWORD, log.getvalue())
        self.assertIsNone(self.notice())  # nobody was told, so the next email is still the first
        self.gmail.login_error = None

        # One address refused: the others still get theirs.
        self.gmail.refuse = {'zoe@example.com'}
        self.assertEqual(self.notify(), {'sent': 1, 'failed': 1, 'recipients': 2, 'kind': 'new'})
        self.assertEqual(self.gmail.to(), ['friend@example.com'])
        self.assertEqual(self.notice()[1:], (0, 0))

        # Every address refused: an error, and what people were told is left as it was.
        self.gmail.refuse = {'friend@example.com', 'zoe@example.com'}
        self.save(self.meeting(dueTime='09:00'))
        self.assertEqual(self.notify(status=502), {'error': 'Gmail refused every recipient.', 'retry': True})
        snapshot, sequence, _ = self.notice()
        self.assertEqual((snapshot['dueTime'], sequence), ('14:00', 0))
        # Every round counts for the hour; only emails that went out count for the day.
        self.assertEqual([sent for _, sent in self.mail_log()], [0, 1, 0])

    def test_whether_trying_again_can_help(self):
        self.save(self.meeting())
        # Gmail refused the sign-in, or the account reached its sending limit:
        # the page shouldn't offer to try again. A dropped connection: it may.
        for message, retry in [
            ('smtp.gmail.com did not accept the email address and password.', False),
            ("Gmail says this account has sent too many emails today. Please try again tomorrow.", False),
            ('smtp.gmail.com closed the connection.', True),
        ]:
            error = mail_error(message, retry)
            with mock.patch.object(dayplan_mail, 'send', side_effect=error):
                res = self.notify(status=502)
            self.assertEqual(res, {'error': message, 'retry': retry})
        # An error that doesn't say (from an older dayplan_mail) may be tried again.
        error = dayplan_mail.MailError('Could not connect to the email server smtp.gmail.com.')
        vars(error).pop('retry', None)
        with mock.patch.object(dayplan_mail, 'send', side_effect=error):
            self.assertIs(self.notify(status=502)['retry'], True)
        self.assertIsNone(self.notice())
        self.assertEqual([sent for _, sent in self.mail_log()], [0, 0, 0, 0])

        # No address could be emailed safely: nothing is sent, and it may be tried again.
        with mock.patch.object(dayplan_mail, 'compose', side_effect=ValueError('unsafe address')):
            res = self.notify(status=502)
        self.assertEqual(res, {'error': 'Gmail refused every recipient.', 'retry': True})
        self.assertEqual(self.gmail.connections, [])
        self.assertEqual(len(self.mail_log()), 4)  # and it didn't use up a round

    def test_limits(self):
        self.save(self.meeting())
        with mock.patch.object(dayplan_api, 'MAX_NOTIFY_PER_HOUR', 2):
            self.notify()
            self.notify()
            res = self.notify(status=429)
            self.assertIn('last hour', res['error'])
            self.assertEqual(len(self.gmail.messages), 4)  # nothing more went out
            self.age_mail_log(3601)
            self.notify()
        with mock.patch.object(dayplan_api, 'MAX_MAIL_RECIPIENTS_PER_DAY', 7):
            # 6 emails in the last day (3 rounds to 2 people): 2 more would pass 7.
            res = self.notify(status=429)
            self.assertIn('a day', res['error'])
            self.assertEqual(len(self.gmail.messages), 6)
            self.age_mail_log(24 * 3600)
            self.notify()
        self.assertEqual([sent for _, sent in self.mail_log()], [2])  # older rounds are cleared

    def test_the_database_is_free_while_emails_are_sent(self):
        self.save(self.meeting())
        writes = []

        def write_meanwhile(msg):
            other = sqlite3.connect(os.environ['DAYPLAN_DB'], timeout=0)  # fails at once if locked
            try:
                with other:
                    other.execute('BEGIN IMMEDIATE')
                    other.execute("INSERT INTO settings (key, value) VALUES (?, '')", ('test ' + msg['To'],))
            finally:
                other.close()
            writes.append(msg['To'])

        self.gmail.on_send = write_meanwhile
        self.assertEqual(self.notify()['sent'], 2)
        self.assertEqual(writes, ['friend@example.com', 'zoe@example.com'])

    @unittest.skipUnless(HAS_ZONES, 'needs zoneinfo and time zone data')
    def test_times_on_each_persons_own_clock(self):
        self.assertEqual(self.friend.post('/api/account', {'timeZone': 'Europe/London'})['status'], 200)
        self.save(self.meeting())
        self.notify()
        texts = {msg['To']: text_of(msg) for msg in self.gmail.messages}
        self.assertIn('Your time: Thu, Oct 22, 7:00 – 8:00 PM BST', texts['friend@example.com'])
        self.assertNotIn('Your time', texts['zoe@example.com'])  # no time zone known

    def test_nobody_to_email(self):
        for email in ('friend@example.com', 'zoe@example.com'):
            self.admin.post('/api/admin/users', {'email': email, 'action': 'disable'})
        self.save(self.meeting())
        self.assertEqual(self.notify(), {'sent': 0, 'failed': 0, 'recipients': 0, 'kind': 'new'})
        self.assertEqual(self.gmail.connections, [])
        self.assertIsNone(self.notice())
        self.assertEqual(self.mail_log(), [])

    def test_the_admin_sees_whether_email_is_ready(self):
        mail = {'ready': True, 'sender': SENDER, 'recipients': 2, 'viewers': 2}
        self.assertEqual(self.admin.get('/api/me')['json']['mail'], mail)
        overview = self.admin.get('/api/admin/users')['json']
        self.assertEqual(overview['mail'], mail)
        self.assertEqual(
            {u['email']: u['notify'] for u in overview['users']},
            {EMAIL: True, 'friend@example.com': True, 'zoe@example.com': True},
        )
        # Only the admin is told.
        self.assertNotIn('mail', self.friend.get('/api/me')['json'])
        self.assertNotIn('mail', Client().get('/api/me')['json'])

        self.assertEqual(self.zoe.post('/api/account', {'notify': False})['status'], 200)
        overview = self.admin.get('/api/admin/users')['json']
        self.assertEqual(overview['mail'], {**mail, 'recipients': 1})
        self.assertFalse({u['email']: u['notify'] for u in overview['users']}['zoe@example.com'])
        dayplan_mail.delete_config(dayplan_api.mail_config_path())
        self.assertEqual(self.admin.get('/api/me')['json']['mail'], {**mail, 'ready': False, 'sender': '', 'recipients': 1})

    def test_everyone_signed_in_sees_whether_email_is_set_up(self):
        for client in (self.admin, self.friend):
            self.assertIs(client.get('/api/me')['json']['mailReady'], True)
        # A viewer learns only that: not the sending address or anything else about it.
        me = self.friend.get('/api/me')
        self.assertNotIn('mail', me['json'])
        self.assertNotIn(SENDER.encode(), me['body'])
        self.assertNotIn('mailReady', Client().get('/api/me')['json'])  # nor does anyone signed out

        dayplan_mail.delete_config(dayplan_api.mail_config_path())
        for client in (self.admin, self.friend):
            self.assertIs(client.get('/api/me')['json']['mailReady'], False)
        self.assertNotIn('mailReady', Client().get('/api/me')['json'])
        # Set up from a console: it shows straight away, without a reload.
        dayplan_mail.save_config(dayplan_api.mail_config_path(), {'username': SENDER, 'password': APP_PASSWORD})
        self.assertIs(self.zoe.get('/api/me')['json']['mailReady'], True)

    def test_deleting_an_account_clears_its_notices(self):
        boss = self.member('boss@example.com', admin=True)
        self.save(self.meeting('b1'), client=boss)
        self.assertEqual(self.notify('b1', client=boss)['kind'], 'new')
        self.save(self.meeting())
        self.notify()
        res = self.admin.post('/api/admin/users', {'email': 'boss@example.com', 'action': 'delete'})
        self.assertEqual(res['status'], 200)
        conn = dayplan_api.connect()
        self.assertEqual([row[0] for row in conn.execute('SELECT plan_id FROM notices')], ['m1'])
        conn.close()

    def test_link_to_the_site(self):
        site_url = dayplan_api.site_url
        self.assertEqual(
            site_url({'HTTP_HOST': 'dayplan.pythonanywhere.com', 'HTTP_X_FORWARDED_PROTO': 'https',
                      'wsgi.url_scheme': 'http'}),
            'https://dayplan.pythonanywhere.com/',
        )
        self.assertEqual(
            site_url({'HTTP_HOST': 'example.com', 'wsgi.url_scheme': 'http', 'SCRIPT_NAME': '//planner//app/'}),
            'http://example.com/planner/app/',
        )

    def test_settings_file_sits_next_to_the_database(self):
        self.assertEqual(str(dayplan_api.mail_config_path()), os.environ['DAYPLAN_MAIL'])
        with mock.patch.dict(os.environ, {'DAYPLAN_MAIL': ''}):
            self.assertEqual(dayplan_api.mail_config_path(), Path(os.environ['DAYPLAN_DB']).parent / 'mail.json')


class AccountSettings(ApiTestCase):
    """Each approved account's own email settings (POST /api/account)."""

    def setUp(self):
        super().setUp()
        self.admin = self.signed_in()
        self.friend = self.member('friend@example.com')

    def test_turning_emails_off_and_on(self):
        res = self.friend.post('/api/account', {'notify': False})
        self.assertEqual((res['status'], res['json']), (200, {'user': public('friend@example.com', notify=False)}))
        self.assertEqual(self.friend.get('/api/me')['json']['user'], public('friend@example.com', notify=False))
        self.assertEqual(self.admin.get('/api/me')['json']['mail']['recipients'], 0)
        res = self.friend.post('/api/account', {'notify': True})
        self.assertEqual(res['json']['user'], public('friend@example.com'))
        self.assertEqual(self.admin.get('/api/me')['json']['mail']['recipients'], 1)

    def test_time_zone(self):
        res = self.friend.post('/api/account', {'timeZone': 'Europe/London'})
        self.assertEqual(res['json']['user'], public('friend@example.com', zone='Europe/London'))
        # One setting at a time leaves the other one alone.
        self.friend.post('/api/account', {'notify': False})
        me = self.friend.get('/api/me')['json']['user']
        self.assertEqual(me, public('friend@example.com', notify=False, zone='Europe/London'))
        res = self.friend.post('/api/account', {'timeZone': '', 'notify': True})
        self.assertEqual(res['json']['user'], public('friend@example.com'))
        res = self.admin.post('/api/account', {'timeZone': 'UTC'})
        self.assertEqual(res['json']['user'], public(EMAIL, admin=True, zone='UTC'))

    def test_bad_requests(self):
        bad = [
            {}, {'notify': 'no'}, {'notify': 0}, {'notify': None}, {'timeZone': 5}, {'timeZone': None},
            {'timeZone': 'not a zone'}, {'timeZone': '../../etc/passwd'}, {'timeZone': '/etc/localtime'},
            {'timeZone': 'Europe/' + 'X' * 64}, {'notify': False, 'timeZone': 'Nowhere at all'},
        ]
        if HAS_ZONES:
            bad.append({'timeZone': 'Mars/Olympus_Mons'})
        for body in bad:
            self.assertEqual(self.friend.post('/api/account', body)['status'], 400, body)
        self.assertEqual(self.friend.get('/api/me')['json']['user'], public('friend@example.com'))  # nothing changed
        self.assertEqual(Client().post('/api/account', {'notify': False})['status'], 401)
        self.assertEqual(self.friend.post('/api/account', {'notify': False}, origin='https://evil.example')['status'], 403)
        self.assertEqual(self.friend.get('/api/account')['status'], 405)
        self.admin.post('/api/admin/users', {'email': 'friend@example.com', 'action': 'disable'})
        self.assertEqual(self.friend.post('/api/account', {'notify': False})['status'], 401)


class CommandLineEmail(ApiTestCase):
    SPACED = 'wxyz qrst uvkl mnop'  # the app password as Google shows it

    def run_main(self, *args, inputs=(), password=SPACED):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch('builtins.input', side_effect=list(inputs)), \
                mock.patch('getpass.getpass', return_value=password), \
                mock.patch('sys.stdout', new=out), mock.patch('sys.stderr', new=err):
            code = dayplan_api.main(['x'] + list(args))
        for text in (out.getvalue(), err.getvalue()):
            self.assertNotIn(APP_PASSWORD, text)
            self.assertNotIn(self.SPACED, text)
        return code, out.getvalue(), err.getvalue()

    def saved(self):
        return dayplan_mail.load_config(dayplan_api.mail_config_path())

    def test_setup_email_saves_only_after_a_test_email_went_out(self):
        path = dayplan_api.mail_config_path()
        self.gmail.login_error = smtplib.SMTPAuthenticationError(535, b'5.7.8 Username and Password not accepted')
        code, out, err = self.run_main('setup-email', inputs=[SENDER, ''])
        self.assertEqual(code, 1)
        self.assertIn('app password', err)
        self.assertIn('Nothing was saved', err)
        self.assertFalse(path.exists())
        self.gmail.login_error = None

        self.gmail.refuse = {SENDER}
        self.assertEqual(self.run_main('setup-email', inputs=[SENDER, ''])[0], 1)
        self.assertFalse(path.exists())
        self.gmail.refuse = set()

        code, out, err = self.run_main('setup-email', inputs=['  ' + SENDER + ' ', ''])
        self.assertEqual((code, err), (0, ''))
        self.assertEqual(self.gmail.to(), [SENDER])
        self.assertEqual(self.gmail.logins[-1], (SENDER, APP_PASSWORD))  # without the spaces
        self.assertEqual(self.saved(), {
            'host': 'smtp.gmail.com', 'port': 587, 'username': SENDER, 'password': APP_PASSWORD, 'from_name': 'Dayplan',
        })
        self.assertEqual(stat.S_IMODE(os.stat(str(path)).st_mode), 0o600)
        self.assertIn(str(path), out)
        self.assertIn('emails are on', out)

        # Run again to change the sender's name.
        self.assertEqual(self.run_main('setup-email', inputs=[SENDER, "Sam's interviews"])[0], 0)
        self.assertEqual(self.saved()['from_name'], "Sam's interviews")

    def test_setup_email_refuses_bad_answers(self):
        for inputs, password in [
            (['not-an-email', ''], self.SPACED),
            (['bad<address>@gmail.com', ''], self.SPACED),
            ([SENDER, ''], '   '),
            ([SENDER, 'x' * 61], self.SPACED),
            ([SENDER, 'Line\x1bbreak'], self.SPACED),
        ]:
            code, out, err = self.run_main('setup-email', inputs=inputs, password=password)
            self.assertEqual(code, 1, inputs)
            self.assertIn('Nothing was saved', err)
        self.assertFalse(dayplan_api.mail_config_path().exists())
        self.assertEqual(self.gmail.connections, [])

    def test_test_email_and_email_off(self):
        code, out, err = self.run_main('test-email', 'friend@example.com')
        self.assertEqual(code, 1)
        self.assertIn('setup-email', err)
        dayplan_mail.save_config(dayplan_api.mail_config_path(), {'username': SENDER, 'password': APP_PASSWORD})

        code, out, err = self.run_main('test-email', 'friend@example.com')
        self.assertEqual(code, 0)
        self.assertIn('friend@example.com', out)
        self.assertEqual(self.gmail.to(), ['friend@example.com'])
        self.assertEqual(self.run_main('test-email', 'not an address')[0], 1)
        self.gmail.login_error = smtplib.SMTPAuthenticationError(535, b'5.7.8 Username and Password not accepted')
        code, out, err = self.run_main('test-email', 'friend@example.com')
        self.assertEqual(code, 1)
        self.assertIn('app password', err)

        code, out, err = self.run_main('email-off')
        self.assertEqual(code, 0)
        self.assertIn('off', out)
        self.assertFalse(dayplan_api.mail_config_path().exists())
        code, out, err = self.run_main('email-off')
        self.assertEqual(code, 0)
        self.assertIn('nothing to turn off', out)

    def test_usage_lists_the_email_commands(self):
        code, out, err = self.run_main('help')
        self.assertEqual(code, 1)
        for command in ('setup-email', 'test-email EMAIL', 'email-off'):
            self.assertIn(command, out)


if __name__ == '__main__':
    unittest.main()
