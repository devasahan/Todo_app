"""Accounts and plan sync for Dayplan, using only the Python standard library.

Plans are stored per account in a SQLite file outside the repository
(by default ../dayplan-data/dayplan.sqlite3, i.e. /home/<you>/dayplan-data/
on PythonAnywhere), so `git pull` never touches them.

Anyone can ask for an account. The very first account becomes the admin
and is active straight away; every later account waits until the admin
approves it (in the app: account menu > Manage users). The admin can also
turn accounts off, delete them, and stop new sign-ups.

From a console:

    python3 ~/Todo_app/dayplan_api.py list-users
    python3 ~/Todo_app/dayplan_api.py approve someone@example.com
    python3 ~/Todo_app/dayplan_api.py set-password someone@example.com
    python3 ~/Todo_app/dayplan_api.py make-admin someone@example.com

`set-password` creates an active account or resets a forgotten password
(and signs that account out everywhere).
"""
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import time
import traceback
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
DEFAULT_DB = ROOT.parent / 'dayplan-data' / 'dayplan.sqlite3'

SESSION_COOKIE = 'dayplan_session'
SESSION_SECONDS = 90 * 24 * 3600
PBKDF2_ITERATIONS = 600_000
MIN_PASSWORD = 8
MAX_PASSWORD = 200
MAX_BODY_BYTES = 5 * 1024 * 1024
MAX_PLAN_BYTES = 100_000
MAX_PLANS = 10_000
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_FAILURES = 10
MAX_PENDING = 50  # unanswered sign-up requests, so strangers can't flood the database
# Password hashing is deliberately slow (~0.4 s). Cap it site-wide so a flood of
# sign-in or sign-up attempts with ever-changing emails can't tie up the server.
MAX_PASSWORD_CHECKS_PER_MINUTE = 30
REQUEST_SENT = (
    "Thanks! Your request has been sent. Once the admin approves it, you can sign in. "
    '(If you already have an account, just sign in.)'
)
STATUSES = ('active', 'pending', 'disabled')
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    is_admin INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    data TEXT,
    rev INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS plans_by_rev ON plans (user_id, rev);
CREATE TABLE IF NOT EXISTS login_failures (
    email TEXT NOT NULL,
    at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS password_checks (
    at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ------------------------------------------------------------------ storage

def db_path():
    return Path(os.environ.get('DAYPLAN_DB') or DEFAULT_DB)


def connect():
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    conn = sqlite3.connect(str(path), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    conn.executescript(SCHEMA)
    migrate(conn)
    return conn


def migrate(conn):
    """Upgrades databases created before approvals existed."""
    columns = {row['name'] for row in conn.execute('PRAGMA table_info(users)')}
    if 'is_admin' in columns:
        return
    try:
        with conn:
            if 'status' not in columns:
                conn.execute("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
            conn.execute('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0')
            # Whoever created the site's first account is its admin.
            conn.execute('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)')
    except sqlite3.OperationalError:
        pass  # another process upgraded the database at the same moment


# ---------------------------------------------------------------- passwords

def hash_password(password, salt=None, iterations=None):
    salt = salt or secrets.token_bytes(16)
    iterations = iterations or PBKDF2_ITERATIONS
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, iterations)
    return 'pbkdf2_sha256${}${}${}'.format(iterations, salt.hex(), digest.hex())


def verify_password(password, stored):
    try:
        algorithm, iterations, salt_hex, digest_hex = stored.split('$')
        if algorithm != 'pbkdf2_sha256':
            return False
        digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt_hex), int(iterations))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest.hex(), digest_hex)


_dummy_hash = None


def reserve_password_check(conn):
    """Counts a password check against the site-wide limit, or refuses it."""
    now = int(time.time())
    with conn:
        conn.execute('DELETE FROM password_checks WHERE at < ?', (now - 60,))
        recent = conn.execute('SELECT COUNT(*) FROM password_checks').fetchone()[0]
        if recent >= MAX_PASSWORD_CHECKS_PER_MINUTE:
            raise ApiError(429, 'Too many sign-in attempts on this site right now. Please wait a minute and try again.')
        conn.execute('INSERT INTO password_checks (at) VALUES (?)', (now,))


def burn_password_check(password):
    """Spends the same time as a real check, so unknown emails aren't revealed by timing."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = hash_password('not-a-real-password')
    verify_password(password, _dummy_hash)


# ---------------------------------------------------------------- validation

def is_text(value, max_length):
    if not isinstance(value, str) or not value or len(value) > max_length:
        return False
    try:
        value.encode('utf-8')  # rejects lone surrogates, which SQLite can't store
    except UnicodeEncodeError:
        return False
    return True


def read_credentials(body, creating):
    email = body.get('email')
    password = body.get('password')
    if not is_text(email, 254) or not EMAIL_RE.match(email.strip()):
        raise ApiError(400, 'Enter a valid email address.')
    if not is_text(password, MAX_PASSWORD):
        raise ApiError(400, 'Enter your password.')
    if creating and len(password) < MIN_PASSWORD:
        raise ApiError(400, 'Use at least {} characters for your password.'.format(MIN_PASSWORD))
    return email.strip().lower(), password


# ----------------------------------------------------------------- accounts

def count_users(conn):
    return conn.execute('SELECT COUNT(*) FROM users').fetchone()[0]


def count_pending(conn):
    return conn.execute("SELECT COUNT(*) FROM users WHERE status = 'pending'").fetchone()[0]


def get_setting(conn, key, default):
    row = conn.execute('SELECT value FROM settings WHERE key = ?', (key,)).fetchone()
    return row['value'] if row else default


def signup_open(conn):
    """Whether this site accepts new sign-up requests (the first account always can)."""
    return count_users(conn) == 0 or get_setting(conn, 'signup', '1') == '1'


def set_password(conn, email, password, status='active', admin=False):
    """Creates the account, or replaces its password and signs it out everywhere.

    `status` and `admin` only apply when the account is new.
    """
    hashed = hash_password(password)
    with conn:
        row = conn.execute('SELECT id FROM users WHERE email = ?', (email,)).fetchone()
        if row:
            conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', (hashed, row['id']))
            conn.execute('DELETE FROM sessions WHERE user_id = ?', (row['id'],))
            return row['id']
        cur = conn.execute(
            'INSERT INTO users (email, password_hash, created_at, status, is_admin) VALUES (?, ?, ?, ?, ?)',
            (email, hashed, int(time.time()), status, 1 if admin else 0),
        )
        return cur.lastrowid


def create_session(conn, user_id):
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    with conn:
        conn.execute('DELETE FROM sessions WHERE expires_at < ?', (now,))
        conn.execute(
            'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
            (token_digest(token), user_id, now + SESSION_SECONDS),
        )
    return token


def token_digest(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def session_token(environ):
    try:
        cookie = SimpleCookie(environ.get('HTTP_COOKIE', ''))
    except CookieError:
        return None
    morsel = cookie.get(SESSION_COOKIE)
    return morsel.value if morsel and morsel.value else None


def current_user(conn, environ):
    token = session_token(environ)
    if not token:
        return None
    return conn.execute(
        'SELECT users.id, users.email, users.is_admin FROM sessions JOIN users ON users.id = sessions.user_id '
        "WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.status = 'active'",
        (token_digest(token), int(time.time())),
    ).fetchone()


def public_user(user):
    return {'email': user['email'], 'admin': bool(user['is_admin'])}


def is_https(environ):
    return environ.get('HTTP_X_FORWARDED_PROTO', environ.get('wsgi.url_scheme', '')).lower() == 'https'


def session_cookie(environ, token, max_age):
    path = environ.get('SCRIPT_NAME') or '/'
    parts = ['{}={}'.format(SESSION_COOKIE, token), 'Path=' + path, 'Max-Age={}'.format(max_age), 'HttpOnly', 'SameSite=Lax']
    if is_https(environ):
        parts.append('Secure')
    return ('Set-Cookie', '; '.join(parts))


# ---------------------------------------------------------------- endpoints

def api_me(conn, environ, body):
    user = current_user(conn, environ)
    payload = {
        'user': public_user(user) if user else None,
        'signup': signup_open(conn),
        'first': count_users(conn) == 0,
    }
    if user and user['is_admin']:
        payload['pending'] = count_pending(conn)
    return 200, payload, []


def api_register(conn, environ, body):
    """The first account becomes the active admin; later ones wait for approval.

    For later sign-ups the answer is the same whether or not the email already
    has an account (and takes as long), so strangers can't use sign-up to find
    out who uses this site.
    """
    email, password = read_credentials(body, creating=True)
    first = count_users(conn) == 0
    if not signup_open(conn):
        raise ApiError(403, "This site isn't accepting new accounts right now.")
    if not first and count_pending(conn) >= MAX_PENDING:
        raise ApiError(429, 'Too many people are waiting for approval right now. Please try again later.')
    reserve_password_check(conn)

    if first:
        user_id = set_password(conn, email, password, status='active', admin=True)
        token = create_session(conn, user_id)
        return 201, {'user': {'email': email, 'admin': True}}, [session_cookie(environ, token, SESSION_SECONDS)]

    if conn.execute('SELECT 1 FROM users WHERE email = ?', (email,)).fetchone():
        burn_password_check(password)  # same time as creating an account; nothing changes
    else:
        set_password(conn, email, password, status='pending')
    return 202, {'pending': True, 'message': REQUEST_SENT}, []


def api_login(conn, environ, body):
    email, password = read_credentials(body, creating=False)
    now = int(time.time())
    with conn:
        conn.execute('DELETE FROM login_failures WHERE at < ?', (now - LOGIN_WINDOW_SECONDS,))
    failures = conn.execute('SELECT COUNT(*) FROM login_failures WHERE email = ?', (email,)).fetchone()[0]
    if failures >= LOGIN_MAX_FAILURES:
        raise ApiError(429, 'Too many attempts. Wait 15 minutes and try again.')
    reserve_password_check(conn)

    user = conn.execute(
        'SELECT id, email, password_hash, status, is_admin FROM users WHERE email = ?', (email,)
    ).fetchone()
    if user is None:
        burn_password_check(password)
    if user is None or not verify_password(password, user['password_hash']):
        with conn:
            conn.execute('INSERT INTO login_failures (email, at) VALUES (?, ?)', (email, now))
        raise ApiError(401, 'Wrong email or password.')

    with conn:
        conn.execute('DELETE FROM login_failures WHERE email = ?', (email,))
    # Only reveal the account's state to someone who knows its password.
    if user['status'] == 'pending':
        raise ApiError(403, "Your account is waiting for the admin's approval. Please try again later.")
    if user['status'] != 'active':
        raise ApiError(403, 'This account has been turned off. Contact the admin of this site.')
    token = create_session(conn, user['id'])
    return 200, {'user': public_user(user)}, [session_cookie(environ, token, SESSION_SECONDS)]


def api_logout(conn, environ, body):
    token = session_token(environ)
    if token:
        with conn:
            conn.execute('DELETE FROM sessions WHERE token_hash = ?', (token_digest(token),))
    return 200, {'ok': True}, [session_cookie(environ, '', 0)]


def api_sync(conn, environ, body):
    """Saves the client's changed plans and returns everything changed elsewhere.

    Request:  {"cursor": <last rev seen>, "changes": [{"id": "...", "data": {...} or null}]}
    Response: {"cursor": <new rev>, "changes": [...]}  or  {"reset": true}
    A null `data` means the plan was deleted. The last change to reach the
    server wins.
    """
    user = current_user(conn, environ)
    if user is None:
        raise ApiError(401, 'Please sign in again.')

    cursor = body.get('cursor')
    changes = body.get('changes', [])
    if not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 0:
        raise ApiError(400, 'Invalid cursor.')
    if not isinstance(changes, list) or len(changes) > MAX_PLANS:
        raise ApiError(400, 'Invalid changes.')

    cleaned = []
    for change in changes:
        if not isinstance(change, dict) or not is_text(change.get('id'), 100):
            raise ApiError(400, 'Invalid change.')
        data = change.get('data')
        if data is None:
            cleaned.append((change['id'], None))
            continue
        if not isinstance(data, dict):
            raise ApiError(400, 'Invalid plan.')
        encoded = json.dumps(data, separators=(',', ':'))
        if len(encoded) > MAX_PLAN_BYTES:
            raise ApiError(413, 'A plan is too large to save.')
        cleaned.append((change['id'], encoded))

    with conn:
        conn.execute('BEGIN IMMEDIATE')
        rev = conn.execute('SELECT rev FROM users WHERE id = ?', (user['id'],)).fetchone()[0]
        if cursor > rev:
            # The client remembers a newer state than the server has (e.g. the
            # database was restored from an older copy): start over.
            return 200, {'reset': True}, []

        sent = set()
        for plan_id, data in cleaned:
            sent.add(plan_id)
            exists = conn.execute(
                'SELECT data IS NOT NULL AS live FROM plans WHERE user_id = ? AND id = ?', (user['id'], plan_id)
            ).fetchone()
            if data is None and not exists:
                continue  # deleting something the server never had
            if data is not None and not (exists and exists['live']):
                live = conn.execute(
                    'SELECT COUNT(*) FROM plans WHERE user_id = ? AND data IS NOT NULL', (user['id'],)
                ).fetchone()[0]
                if live >= MAX_PLANS:
                    raise ApiError(413, 'This account has too many plans.')
            rev += 1
            conn.execute(
                'INSERT INTO plans (user_id, id, data, rev) VALUES (?, ?, ?, ?) '
                'ON CONFLICT (user_id, id) DO UPDATE SET data = excluded.data, rev = excluded.rev',
                (user['id'], plan_id, data, rev),
            )
        conn.execute('UPDATE users SET rev = ? WHERE id = ?', (rev, user['id']))

        rows = conn.execute(
            'SELECT id, data FROM plans WHERE user_id = ? AND rev > ? ORDER BY rev', (user['id'], cursor)
        ).fetchall()

    remote = [
        {'id': row['id'], 'data': json.loads(row['data']) if row['data'] is not None else None}
        for row in rows
        if row['id'] not in sent  # the client already has what it just sent
    ]
    payload = {'cursor': rev, 'changes': remote}
    if user['is_admin']:
        payload['pending'] = count_pending(conn)  # keeps the admin's badge current
    return 200, payload, []


# -------------------------------------------------------------------- admin

def require_admin(conn, environ):
    user = current_user(conn, environ)
    if user is None:
        raise ApiError(401, 'Please sign in again.')
    if not user['is_admin']:
        raise ApiError(403, 'Only the admin can do that.')
    return user


def admin_overview(conn):
    rows = conn.execute(
        'SELECT users.email, users.status, users.is_admin, users.created_at, '
        '(SELECT COUNT(*) FROM plans WHERE plans.user_id = users.id AND plans.data IS NOT NULL) AS plans '
        'FROM users ORDER BY users.created_at, users.id'
    ).fetchall()
    users = [
        {
            'email': row['email'],
            'status': row['status'],
            'admin': bool(row['is_admin']),
            'createdAt': row['created_at'],
            'plans': row['plans'],
        }
        for row in rows
    ]
    return {'users': users, 'signup': get_setting(conn, 'signup', '1') == '1', 'pending': count_pending(conn)}


def api_admin_users(conn, environ, body):
    require_admin(conn, environ)
    return 200, admin_overview(conn), []


def api_admin_update_user(conn, environ, body):
    """Body: {"email": "...", "action": "approve" | "disable" | "enable" | "delete"}."""
    me = require_admin(conn, environ)
    email = body.get('email')
    action = body.get('action')
    if action not in ('approve', 'disable', 'enable', 'delete') or not is_text(email, 254):
        raise ApiError(400, 'Invalid request.')
    target = conn.execute('SELECT id, status FROM users WHERE email = ?', (email,)).fetchone()
    if target is None:
        raise ApiError(404, "That account doesn't exist anymore.")
    if target['id'] == me['id']:
        raise ApiError(400, "You can't change your own account here.")

    with conn:
        if action in ('approve', 'enable'):
            conn.execute("UPDATE users SET status = 'active' WHERE id = ?", (target['id'],))
        elif action == 'disable':
            conn.execute("UPDATE users SET status = 'disabled' WHERE id = ?", (target['id'],))
            conn.execute('DELETE FROM sessions WHERE user_id = ?', (target['id'],))
        else:
            conn.execute('DELETE FROM plans WHERE user_id = ?', (target['id'],))
            conn.execute('DELETE FROM sessions WHERE user_id = ?', (target['id'],))
            conn.execute('DELETE FROM users WHERE id = ?', (target['id'],))
    return 200, admin_overview(conn), []


def api_admin_settings(conn, environ, body):
    """Body: {"signup": true | false} to accept or stop new sign-up requests."""
    require_admin(conn, environ)
    if not isinstance(body.get('signup'), bool):
        raise ApiError(400, 'Invalid request.')
    with conn:
        conn.execute(
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
            ('signup', '1' if body['signup'] else '0'),
        )
    return 200, admin_overview(conn), []


ROUTES = {
    '/api/me': {'GET': api_me},
    '/api/register': {'POST': api_register},
    '/api/login': {'POST': api_login},
    '/api/logout': {'POST': api_logout},
    '/api/sync': {'POST': api_sync},
    '/api/admin/users': {'GET': api_admin_users, 'POST': api_admin_update_user},
    '/api/admin/settings': {'POST': api_admin_settings},
}


# ------------------------------------------------------------------- WSGI

def check_same_origin(environ):
    """Blocks requests sent from other websites (CSRF)."""
    content_type = environ.get('CONTENT_TYPE', '').split(';')[0].strip().lower()
    if content_type != 'application/json':
        raise ApiError(415, 'Expected JSON.')
    origin = environ.get('HTTP_ORIGIN')
    host = environ.get('HTTP_HOST')
    if origin and host and urlsplit(origin).netloc.lower() != host.lower():
        raise ApiError(403, 'Cross-site request blocked.')


def read_json(environ):
    try:
        length = int(environ.get('CONTENT_LENGTH') or 0)
    except ValueError:
        raise ApiError(400, 'Invalid request.')
    if length > MAX_BODY_BYTES:
        raise ApiError(413, 'Request too large.')
    if length <= 0:
        return {}
    raw = environ['wsgi.input'].read(length)
    try:
        body = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        raise ApiError(400, 'Invalid JSON.')
    if not isinstance(body, dict):
        raise ApiError(400, 'Invalid JSON.')
    return body


def handle(environ, start_response):
    path = environ.get('PATH_INFO', '')
    method = environ.get('REQUEST_METHOD', 'GET')
    headers = [('Content-Type', 'application/json'), ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff')]
    try:
        route = ROUTES.get(path)
        if route is None:
            raise ApiError(404, 'Not found.')
        endpoint = route.get(method)
        if endpoint is None:
            headers.append(('Allow', ', '.join(route)))
            raise ApiError(405, 'Method not allowed.')
        body = {}
        if method == 'POST':
            check_same_origin(environ)
            body = read_json(environ)
        conn = connect()
        try:
            status, payload, extra = endpoint(conn, environ, body)
        finally:
            conn.close()
        headers.extend(extra)
    except ApiError as err:
        status, payload = err.status, {'error': err.message}
    except Exception:  # never leak details; the traceback goes to the error log
        traceback.print_exc(file=sys.stderr)
        status, payload = 500, {'error': 'Something went wrong on the server.'}

    data = json.dumps(payload).encode('utf-8')
    headers.append(('Content-Length', str(len(data))))
    start_response('{} {}'.format(status, STATUS_TEXT.get(status, 'Error')), headers)
    return [data]


STATUS_TEXT = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Payload Too Large',
    415: 'Unsupported Media Type', 429: 'Too Many Requests', 500: 'Internal Server Error',
}


# -------------------------------------------------------------------- CLI

def main(argv):
    usage = (
        'Usage:\n'
        '  python3 dayplan_api.py list-users\n'
        '  python3 dayplan_api.py approve EMAIL\n'
        '  python3 dayplan_api.py set-password EMAIL\n'
        '  python3 dayplan_api.py make-admin EMAIL'
    )
    if len(argv) == 2 and argv[1] == 'list-users':
        conn = connect()
        rows = conn.execute('SELECT email, status, is_admin FROM users ORDER BY id').fetchall()
        for row in rows:
            print('{:<40} {}{}'.format(row['email'], row['status'], ' (admin)' if row['is_admin'] else ''))
        if not rows:
            print('No accounts yet.')
        return 0
    if len(argv) == 3 and argv[1] in ('approve', 'make-admin'):
        email = argv[2].strip().lower()
        conn = connect()
        with conn:
            if argv[1] == 'approve':
                cur = conn.execute("UPDATE users SET status = 'active' WHERE email = ?", (email,))
            else:
                cur = conn.execute("UPDATE users SET is_admin = 1, status = 'active' WHERE email = ?", (email,))
        if not cur.rowcount:
            print('No account with that email. Run list-users to see all accounts.')
            return 1
        print('{} is now {}.'.format(email, 'active' if argv[1] == 'approve' else 'an admin'))
        return 0
    if len(argv) == 3 and argv[1] == 'set-password':
        email = argv[2].strip().lower()
        if not EMAIL_RE.match(email):
            print('That does not look like an email address.')
            return 1
        password = getpass.getpass('New password for {}: '.format(email))
        if len(password) < MIN_PASSWORD:
            print('Use at least {} characters.'.format(MIN_PASSWORD))
            return 1
        if getpass.getpass('Type it again: ') != password:
            print('The passwords did not match. Nothing was changed.')
            return 1
        conn = connect()
        set_password(conn, email, password, status='active', admin=count_users(conn) == 0)
        print('Password set for {}. Any old sign-ins for this account were ended.'.format(email))
        return 0
    print(usage)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
