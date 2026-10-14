"""Tests for dayplan_api.py. Run with: python3 -m unittest discover -s tests"""
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from wsgiref.util import setup_testing_defaults

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import dayplan_api  # noqa: E402
from dayplan_wsgi import application  # noqa: E402

EMAIL = 'me@example.com'
PASSWORD = 'correct horse battery'
_clock = [0]


def stamp(offset=None):
    """Increasing ISO times, like a plan's updatedAt (or a given offset in seconds)."""
    if offset is None:
        _clock[0] += 1
        offset = _clock[0]
    base = datetime(2026, 10, 14, 9, 0, tzinfo=timezone.utc) + timedelta(seconds=offset)
    return base.strftime('%Y-%m-%dT%H:%M:%S.000Z')


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

    def request(self, method, path, body=None, content_type='application/json', origin='same'):
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
        captured = {}

        def start_response(status, headers):
            captured['status'] = int(status.split()[0])
            captured['headers'] = headers

        raw = b''.join(application(environ, start_response))
        for name, value in captured['headers']:
            if name == 'Set-Cookie':
                pair = value.split(';')[0]
                self.cookie = '' if pair.endswith('=') else pair
                captured['set_cookie'] = value
        captured['json'] = json.loads(raw) if raw else None
        return captured

    def post(self, path, body=None, **kwargs):
        return self.request('POST', path, body, **kwargs)

    def get(self, path):
        return self.request('GET', path)


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        patches = [
            mock.patch.dict(os.environ, {'DAYPLAN_DB': os.path.join(self.tmp.name, 'data', 'db.sqlite3')}),
            mock.patch.object(dayplan_api, 'PBKDF2_ITERATIONS', 1000),  # keep tests fast
            # Every test client shares one address; tests of the per-address limit lower it.
            mock.patch.object(dayplan_api, 'MAX_PASSWORD_CHECKS_PER_ADDRESS', 1000),
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

    def member(self, email, password=PASSWORD):
        """An approved, signed-in second account."""
        dayplan_api.set_password(dayplan_api.connect(), email, password)
        client = Client()
        self.assertEqual(client.post('/api/login', {'email': email, 'password': password})['status'], 200)
        return client

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
        self.assertEqual(me['user'], {'email': EMAIL, 'admin': True})
        self.assertEqual(me['pending'], 0)
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
        self.assertEqual(res['json']['user'], {'email': 'friend@example.com', 'admin': False})
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
        self.assertEqual(res['json']['user'], {'email': EMAIL, 'admin': True})
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
        self.assertEqual(client.get('/api/me')['json']['user'], {'email': EMAIL, 'admin': True})

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
        mine = self.signed_in()
        mine.post('/api/sync', {'cursor': 0, 'changes': [self.plan('secret', 'My diary')]})
        theirs = self.member('other@example.com')
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
        self.friend.post('/api/sync', {'cursor': 0, 'changes': [self.plan('f1', 'Friend plan')]})

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
        self.assertEqual(res['json']['user'], {'email': EMAIL, 'admin': True})
        res = Client().post('/api/login', {'email': 'second@example.com', 'password': PASSWORD})
        self.assertEqual(res['json']['user'], {'email': 'second@example.com', 'admin': False})
        dayplan_api.connect()  # running the upgrade again changes nothing
        self.assertEqual(owner.get('/api/admin/users')['status'], 200)
        # Old plans got their times, so an older copy can't overwrite them.
        res = owner.post('/api/sync', {'cursor': 0, 'changes': [self.plan('p1', 'Stale', at='2026-09-01T00:00:00.000Z')]})
        self.assertEqual({c['id']: c['data']['title'] if c['data'] else None for c in res['json']['changes']}['p1'], 'Old plan')
        # A plan deleted before the upgrade stays deleted when an old copy is offered.
        res = owner.post('/api/sync', {'cursor': 0, 'changes': [self.plan('gone', 'Back?', at=dayplan_api.server_stamp(-60_000))]})
        self.assertIsNone({c['id']: c['data'] for c in res['json']['changes']}['gone'])


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


if __name__ == '__main__':
    unittest.main()


class CommandLineApprovals(ApiTestCase):
    def test_approve_and_make_admin(self):
        self.signed_in()
        Client().post('/api/register', {'email': 'waiting@example.com', 'password': PASSWORD})
        with mock.patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(dayplan_api.main(['x', 'approve', 'Waiting@Example.com']), 0)
            self.assertEqual(dayplan_api.main(['x', 'approve', 'nobody@example.com']), 1)
            self.assertEqual(dayplan_api.main(['x', 'make-admin', 'waiting@example.com']), 0)
        res = Client().post('/api/login', {'email': 'waiting@example.com', 'password': PASSWORD})
        self.assertEqual(res['json']['user'], {'email': 'waiting@example.com', 'admin': True})


class CommandLineRecovery(ApiTestCase):
    def test_make_admin_creates_a_missing_account(self):
        # A stranger grabbed the site and turned sign-ups off; the owner has no account.
        self.signed_in('stranger@example.com')
        with mock.patch('getpass.getpass', side_effect=[PASSWORD, PASSWORD]), mock.patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(dayplan_api.main(['x', 'make-admin', 'owner@example.com']), 0)
        res = Client().post('/api/login', {'email': 'owner@example.com', 'password': PASSWORD})
        self.assertEqual(res['json']['user'], {'email': 'owner@example.com', 'admin': True})

    def test_new_epoch(self):
        client = self.signed_in()
        epoch = client.post('/api/sync', {'cursor': 0, 'changes': []})['json']['epoch']
        with mock.patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(dayplan_api.main(['x', 'new-epoch']), 0)
        res = client.post('/api/sync', {'epoch': epoch, 'cursor': 0, 'changes': []})['json']
        self.assertTrue(res['reset'])
