"""Tests for dayplan_api.py. Run with: python3 -m unittest discover -s tests"""
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from wsgiref.util import setup_testing_defaults

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import dayplan_api  # noqa: E402
from dayplan_wsgi import application  # noqa: E402

EMAIL = 'me@example.com'
PASSWORD = 'correct horse battery'


class Client:
    """A tiny browser: keeps the session cookie between requests."""

    def __init__(self, host='dayplan.example.com', https=True):
        self.cookie = ''
        self.host = host
        self.https = https

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
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        os.environ.pop('DAYPLAN_OPEN_SIGNUP', None)
        dayplan_api._dummy_hash = None
        self.addCleanup(self.tmp.cleanup)

    def signed_in(self, email=EMAIL, password=PASSWORD):
        client = Client()
        res = client.post('/api/register', {'email': email, 'password': password})
        self.assertEqual(res['status'], 201, res['json'])
        return client

    def plan(self, plan_id, title='Plan', **fields):
        return {'id': plan_id, 'data': {'id': plan_id, 'title': title, **fields}}


class Accounts(ApiTestCase):
    def test_first_account_can_sign_up_then_sign_up_closes(self):
        anon = Client()
        self.assertEqual(anon.get('/api/me')['json'], {'user': None, 'signup': True})
        client = self.signed_in()
        self.assertEqual(client.get('/api/me')['json']['user'], {'email': EMAIL})

        stranger = Client()
        self.assertFalse(stranger.get('/api/me')['json']['signup'])
        res = stranger.post('/api/register', {'email': 'other@example.com', 'password': PASSWORD})
        self.assertEqual(res['status'], 403)

    def test_open_signup_setting(self):
        self.signed_in()
        with mock.patch.dict(os.environ, {'DAYPLAN_OPEN_SIGNUP': '1'}):
            self.signed_in('friend@example.com')
            res = Client().post('/api/register', {'email': EMAIL.upper(), 'password': PASSWORD})
            self.assertEqual(res['status'], 409)

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
        self.assertEqual(client.get('/api/me')['json']['user'], {'email': EMAIL})

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
        self.assertEqual(res['json'], {'cursor': 2, 'changes': []})  # nothing echoed back

        phone = Client()
        phone.post('/api/login', {'email': EMAIL, 'password': PASSWORD})
        res = phone.post('/api/sync', {'cursor': 0, 'changes': []})
        self.assertEqual(res['json']['cursor'], 2)
        self.assertEqual(sorted(c['id'] for c in res['json']['changes']), ['a', 'b'])
        self.assertEqual(res['json']['changes'][0]['data']['title'], 'Write report')

        # The phone edits one plan and deletes the other.
        res = phone.post('/api/sync', {'cursor': 2, 'changes': [self.plan('a', 'Report v2'), {'id': 'b', 'data': None}]})
        self.assertEqual(res['json'], {'cursor': 4, 'changes': []})

        res = laptop.post('/api/sync', {'cursor': 2, 'changes': []})
        changes = {c['id']: c['data'] for c in res['json']['changes']}
        self.assertEqual(changes['a']['title'], 'Report v2')
        self.assertIsNone(changes['b'])
        self.assertEqual(res['json']['cursor'], 4)

        # Nothing new since then.
        self.assertEqual(laptop.post('/api/sync', {'cursor': 4, 'changes': []})['json'], {'cursor': 4, 'changes': []})

    def test_accounts_never_see_each_other(self):
        mine = self.signed_in()
        mine.post('/api/sync', {'cursor': 0, 'changes': [self.plan('secret', 'My diary')]})
        with mock.patch.dict(os.environ, {'DAYPLAN_OPEN_SIGNUP': '1'}):
            theirs = self.signed_in('other@example.com')
        res = theirs.post('/api/sync', {'cursor': 0, 'changes': []})
        self.assertEqual(res['json'], {'cursor': 0, 'changes': []})
        # Same plan id in another account is a separate plan.
        theirs.post('/api/sync', {'cursor': 0, 'changes': [self.plan('secret', 'Overwrite?')]})
        res = mine.post('/api/sync', {'cursor': 0, 'changes': []})
        self.assertEqual(res['json']['changes'][0]['data']['title'], 'My diary')

    def test_cursor_ahead_of_server_asks_for_reset(self):
        client = self.signed_in()
        res = client.post('/api/sync', {'cursor': 99, 'changes': [self.plan('a')]})
        self.assertEqual(res['json'], {'reset': True})
        # Nothing was saved from the rejected request.
        self.assertEqual(client.post('/api/sync', {'cursor': 0, 'changes': []})['json']['cursor'], 0)

    def test_deleting_unknown_plan_is_harmless(self):
        client = self.signed_in()
        res = client.post('/api/sync', {'cursor': 0, 'changes': [{'id': 'ghost', 'data': None}]})
        self.assertEqual(res['json'], {'cursor': 0, 'changes': []})

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
            self.assertEqual(client.post('/api/sync', {'cursor': 2, 'changes': [self.plan('a', 'x')]})['status'], 200)
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


class CommandLine(ApiTestCase):
    def test_set_password_and_list_users(self):
        with mock.patch('getpass.getpass', side_effect=[PASSWORD, PASSWORD]), mock.patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(dayplan_api.main(['x', 'set-password', 'New@Example.com']), 0)
        with mock.patch('sys.stdout', new=io.StringIO()) as out:
            dayplan_api.main(['x', 'list-users'])
        self.assertIn('new@example.com', out.getvalue())
        with mock.patch('getpass.getpass', side_effect=[PASSWORD, 'different']), mock.patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(dayplan_api.main(['x', 'set-password', 'new@example.com']), 1)
        self.assertEqual(Client().post('/api/login', {'email': 'new@example.com', 'password': PASSWORD})['status'], 200)


if __name__ == '__main__':
    unittest.main()
