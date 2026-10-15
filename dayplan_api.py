"""Accounts and plan sync for Dayplan, using only the Python standard library.

Plans are stored per account in a SQLite file outside the repository
(by default ../dayplan-data/dayplan.sqlite3, i.e. /home/<you>/dayplan-data/
on PythonAnywhere), so `git pull` never touches them.

Anyone can ask for an account. The very first account becomes the admin
and is active straight away; every later account waits until the admin
approves it (in the app: account menu > Manage users). The admin can also
turn accounts off, delete them, and stop new sign-ups.

Only admin accounts plan. Every other approved account can view the
admin's meetings (not their other plans) and change nothing.

An admin can attach PDFs to a meeting (a resume, a cover letter). They are
stored in the same database, and whoever can see the meeting can open them.

From a console:

    python3 ~/Todo_app/dayplan_api.py list-users
    python3 ~/Todo_app/dayplan_api.py approve someone@example.com
    python3 ~/Todo_app/dayplan_api.py set-password someone@example.com
    python3 ~/Todo_app/dayplan_api.py make-admin someone@example.com

`set-password` resets a forgotten password (and signs that account out
everywhere); `add-user` creates an active account; `make-admin` makes an
account the admin, creating it first if needed. After restoring the
database file from a backup, run `new-epoch` so every browser resyncs.
"""
import calendar
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
import unicodedata
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

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
# ...and give each visitor address only a share of that, so one stranger
# can't use it all up and keep everyone else from signing in.
MAX_PASSWORD_CHECKS_PER_ADDRESS = 5
# A deletion from a device whose clock runs ahead must not beat later work:
# its time is capped at the server's clock plus this margin.
MAX_CLOCK_AHEAD_MS = 60_000
# Uploaded PDFs (a meeting's resume or cover letter).
MAX_FILE_BYTES = 10 * 1024 * 1024  # one file; the only request body allowed to be larger than MAX_BODY_BYTES
MAX_ACCOUNT_FILE_BYTES = 200 * 1024 * 1024  # all of one account's files together
MAX_FILES = 500  # files per account
MAX_FILE_NAME = 120
DEFAULT_FILE_NAME = 'document.pdf'
# A new file no plan mentions yet is left alone this long: the plan that uses
# it may not have been synced yet.
UNUSED_FILE_SECONDS = 24 * 3600
# A file no plan has mentioned for this long is deleted. Until then a deleted
# meeting that comes back (undo, a backup, another device) still has its PDFs.
KEEP_UNUSED_SECONDS = 30 * 24 * 3600
VIEW_ONLY = 'This account can view the meeting schedule but not change it.'
WRONG_OR_WAITING = (
    'Wrong email or password. (If you asked for an account recently, '
    "you can sign in once the admin has approved it.)"
)
REQUEST_SENT = (
    "Thanks! Your request has been sent. Once the admin approves it, you can sign in. "
    '(If you already have an account, just sign in.)'
)
STATUSES = ('active', 'pending', 'disabled')
# The parts of the admin's meetings that approved accounts may see. Anything
# else stored with a meeting (and any field added to plans later) stays
# private until it is added here.
SCHEDULE_FIELDS = (
    'kind', 'title', 'company', 'description', 'dueDate', 'dueTime', 'status', 'priority', 'tags',
    'checklist', 'meetingUrl', 'jobUrl', 'createdAt', 'updatedAt', 'startedAt', 'completedAt',
    'timeZone', 'endTime', 'resume', 'coverLetter',
)
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
# Plan versions are compared by their ISO-8601 UTC time, e.g. 2026-10-14T09:30:00.000Z.
STAMP_RE = re.compile(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$')

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
    updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS plans_by_rev ON plans (user_id, rev);
CREATE TABLE IF NOT EXISTS login_failures (
    email TEXT NOT NULL,
    at INTEGER NOT NULL,
    ip TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS password_checks (
    at INTEGER NOT NULL,
    ip TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    unused_since INTEGER  -- when no plan mentioned it any more (NULL while in use)
);
CREATE INDEX IF NOT EXISTS files_by_user ON files (user_id);
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


def columns_of(conn, table):
    return {row['name'] for row in conn.execute('PRAGMA table_info({})'.format(table))}


def migrate(conn):
    """Upgrades databases created by earlier versions."""
    try:
        users = columns_of(conn, 'users')
        if 'is_admin' not in users:
            with conn:
                if 'status' not in users:
                    conn.execute("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
                conn.execute('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0')
                # Whoever created the site's first account is its admin.
                conn.execute('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)')
        if 'updated_at' not in columns_of(conn, 'plans'):
            with conn:
                conn.execute("ALTER TABLE plans ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''")
                for row in conn.execute('SELECT user_id, id, data FROM plans WHERE data IS NOT NULL').fetchall():
                    try:
                        stamp = json.loads(row['data']).get('updatedAt', '')
                    except (ValueError, AttributeError):
                        stamp = ''
                    if canonical_stamp(stamp):
                        conn.execute(
                            'UPDATE plans SET updated_at = ? WHERE user_id = ? AND id = ?',
                            (canonical_stamp(stamp), row['user_id'], row['id']),
                        )
        if 'ip' not in columns_of(conn, 'login_failures'):
            with conn:
                conn.execute("ALTER TABLE login_failures ADD COLUMN ip TEXT NOT NULL DEFAULT ''")
        if 'ip' not in columns_of(conn, 'password_checks'):
            with conn:
                conn.execute("ALTER TABLE password_checks ADD COLUMN ip TEXT NOT NULL DEFAULT ''")
        # Plans deleted before deletions carried a time: date them now, so an
        # older copy offered later can't bring them back.
        with conn:
            conn.execute(
                "UPDATE plans SET updated_at = ? WHERE data IS NULL AND updated_at = ''", (server_stamp(),)
            )
    except sqlite3.OperationalError:
        pass  # another process upgraded the database at the same moment


# Stamps are stored as YYYY-MM-DDTHH:MM:SS.mmmZ (like the browser's
# toISOString()), so comparing them as text compares them in time.

def stamp_ms(stamp):
    """Milliseconds since 1970 for an ISO UTC stamp, or None if it isn't one."""
    match = STAMP_RE.match(stamp) if isinstance(stamp, str) else None
    if not match:
        return None
    try:
        seconds = calendar.timegm(time.strptime(match.group(1), '%Y-%m-%dT%H:%M:%S'))
    except (ValueError, OverflowError):
        return None
    return seconds * 1000 + int(((match.group(2) or '') + '000')[:3])


def format_stamp(ms):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(ms // 1000)) + '.{:03d}Z'.format(ms % 1000)


def canonical_stamp(stamp):
    ms = stamp_ms(stamp)
    return format_stamp(ms) if ms is not None else ''


def server_stamp(offset_ms=0):
    """The server's time (plus an offset) as a stamp."""
    return format_stamp(int(time.time() * 1000) + offset_ms)


def stamp_after(stamp):
    """The stamp 1 ms after `stamp` (or the server's time if it isn't valid)."""
    ms = stamp_ms(stamp)
    return format_stamp(ms + 1) if ms is not None else server_stamp()


def database_epoch(conn):
    """A random id for this database. If it changes (restored from a copy),
    browsers start their sync over instead of trusting their old position."""
    with conn:
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('epoch', ?)", (secrets.token_hex(8),))
    return get_setting(conn, 'epoch', '')


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


def reserve_password_check(conn, ip):
    """Counts a password check against the per-address and site-wide limits, or refuses it."""
    now = int(time.time())
    with conn:
        conn.execute('DELETE FROM password_checks WHERE at < ?', (now - 60,))
        mine = conn.execute('SELECT COUNT(*) FROM password_checks WHERE ip = ?', (ip,)).fetchone()[0]
        if mine >= MAX_PASSWORD_CHECKS_PER_ADDRESS:
            raise ApiError(429, 'Too many attempts. Please wait a minute and try again.')
        recent = conn.execute('SELECT COUNT(*) FROM password_checks').fetchone()[0]
        if recent >= MAX_PASSWORD_CHECKS_PER_MINUTE:
            raise ApiError(429, 'Too many sign-in attempts on this site right now. Please wait a minute and try again.')
        conn.execute('INSERT INTO password_checks (at, ip) VALUES (?, ?)', (now, ip))


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
        return insert_user(conn, email, hashed, status, admin)


def insert_user(conn, email, hashed, status, admin):
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


def client_ip(environ):
    # PythonAnywhere's front end puts the visitor's address in X-Real-IP;
    # REMOTE_ADDR is the proxy there (but the visitor when run directly).
    return (environ.get('HTTP_X_REAL_IP') or environ.get('REMOTE_ADDR') or '')[:64]


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
    reserve_password_check(conn, client_ip(environ))
    hashed = hash_password(password)  # slow, so done before taking the database lock

    with conn:
        # Decide "first account" and create it in one locked step, so two
        # simultaneous sign-ups can't both become the admin.
        conn.execute('BEGIN IMMEDIATE')
        first = count_users(conn) == 0
        exists = conn.execute('SELECT 1 FROM users WHERE email = ?', (email,)).fetchone()
        user_id = None
        if first:
            user_id = insert_user(conn, email, hashed, 'active', True)
        elif not exists:
            insert_user(conn, email, hashed, 'pending', False)
        # An existing email changes nothing, and gets the same answer as a new one.

    if user_id is not None:
        token = create_session(conn, user_id)
        return 201, {'user': {'email': email, 'admin': True}}, [session_cookie(environ, token, SESSION_SECONDS)]
    return 202, {'pending': True, 'message': REQUEST_SENT}, []


def api_login(conn, environ, body):
    email, password = read_credentials(body, creating=False)
    now = int(time.time())
    ip = client_ip(environ)
    with conn:
        conn.execute('DELETE FROM login_failures WHERE at < ?', (now - LOGIN_WINDOW_SECONDS,))
    # Counted per email and visitor address: guessing from one place is
    # stopped, but nobody else can lock the owner out of their own account.
    failures = conn.execute(
        'SELECT COUNT(*) FROM login_failures WHERE email = ? AND ip = ?', (email, ip)
    ).fetchone()[0]
    if failures >= LOGIN_MAX_FAILURES:
        raise ApiError(429, 'Too many attempts. Wait 15 minutes and try again.')
    reserve_password_check(conn, ip)

    user = conn.execute(
        'SELECT id, email, password_hash, status, is_admin FROM users WHERE email = ?', (email,)
    ).fetchone()
    if user is None:
        burn_password_check(password)
    # A request that is still waiting for approval gets the same answer as a
    # wrong password: otherwise a stranger could sign up with any email and
    # then sign in to find out whether that email already had an account.
    if user is None or not verify_password(password, user['password_hash']) or user['status'] == 'pending':
        with conn:
            conn.execute('INSERT INTO login_failures (email, at, ip) VALUES (?, ?, ?)', (email, now, ip))
        raise ApiError(401, WRONG_OR_WAITING)

    with conn:
        conn.execute('DELETE FROM login_failures WHERE email = ? AND ip = ?', (email, ip))
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


def require_planner(conn, environ):
    """The signed-in account, if it may plan (an admin). Every other account only views."""
    user = current_user(conn, environ)
    if user is None:
        raise ApiError(401, 'Please sign in again.')
    if not user['is_admin']:
        raise ApiError(403, VIEW_ONLY)
    return user


def change_stamp(change, data):
    """The time a change was made: the plan's updatedAt, or deletedAt for a deletion.

    A deletion without any deletedAt comes from an older version of the app
    still open in some tab; it gets the server's time. Invalid times lose.
    """
    if data is None and 'deletedAt' not in change:
        return server_stamp()
    stamp = data.get('updatedAt') if data is not None else change.get('deletedAt')
    return canonical_stamp(stamp)


def keep_missing_fields(stored, incoming):
    """Returns `incoming` plus any top-level field the stored copy has and it lacks.

    An older version of the app drops fields it doesn't know about (such as a
    meeting's company and links) when it saves a plan. So a field left out of
    a plan never removes it. To clear a field, send it with an empty value.
    """
    try:
        old = json.loads(stored)
    except ValueError:
        return incoming
    if not isinstance(old, dict):
        return incoming
    missing = {key: value for key, value in old.items() if key not in incoming}
    return {**incoming, **missing} if missing else incoming


def api_sync(conn, environ, body):
    """Saves the client's changed plans and returns everything changed elsewhere.

    Request:  {"epoch": "...", "cursor": <last rev seen>, "full": true (optional),
               "changes": [{"id": "...", "data": {...}} or {"id": "...", "data": null, "deletedAt": "..."}]}
    Response: {"epoch": "...", "cursor": <new rev>, "changes": [...]}  or  {"epoch": "...", "reset": true}

    Each plan keeps the time of its latest change. A change is saved only if
    it is newer than what the server has; otherwise the server's version is
    sent back. So an old copy (from a browser that was signed out for a
    while, a second tab, an undo...) can never overwrite newer work or bring
    back a deleted plan.

    To clear a field, send it with an empty value; leaving it out keeps the stored one.

    "full": true returns every plan instead of only those changed since the
    cursor (used once to repair copies saved by an older version of the app).
    The cursor is still checked, so a database restored from an older copy is
    noticed as usual.

    Only admin accounts have plans. Any other account gets 403 and nothing is
    read or saved: it can only view the admin's meetings (see api_schedule).
    """
    user = require_planner(conn, environ)

    cursor = body.get('cursor')
    changes = body.get('changes', [])
    client_epoch = body.get('epoch')
    if not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 0:
        raise ApiError(400, 'Invalid cursor.')
    if not isinstance(changes, list) or len(changes) > MAX_PLANS:
        raise ApiError(400, 'Invalid changes.')
    if client_epoch is not None and not isinstance(client_epoch, str):
        raise ApiError(400, 'Invalid epoch.')

    cleaned = []
    for change in changes:
        if not isinstance(change, dict) or not is_text(change.get('id'), 100):
            raise ApiError(400, 'Invalid change.')
        data = change.get('data')
        if data is not None and not isinstance(data, dict):
            raise ApiError(400, 'Invalid plan.')
        encoded = None
        if data is not None:
            encoded = json.dumps(data, separators=(',', ':'))
            if len(encoded) > MAX_PLAN_BYTES:
                raise ApiError(413, 'A plan is too large to save.')
        cleaned.append((change['id'], data, encoded, change_stamp(change, data)))

    epoch = database_epoch(conn)
    with conn:
        conn.execute('BEGIN IMMEDIATE')
        rev = conn.execute('SELECT rev FROM users WHERE id = ?', (user['id'],)).fetchone()[0]
        if client_epoch and client_epoch != epoch:
            # This database isn't the one the browser synced with: start over.
            return 200, {'epoch': epoch, 'reset': True}, []
        if cursor > rev:
            # The database went backwards (restored from a copy, which keeps the
            # old epoch). Give it a new epoch so *every* browser starts over,
            # not just the ones that happen to be ahead.
            epoch = secrets.token_hex(8)
            conn.execute("UPDATE settings SET value = ? WHERE key = 'epoch'", (epoch,))
            return 200, {'epoch': epoch, 'reset': True}, []

        saved, stale = set(), set()
        for plan_id, data, encoded, stamp in cleaned:
            row = conn.execute(
                'SELECT data, updated_at FROM plans WHERE user_id = ? AND id = ?',
                (user['id'], plan_id),
            ).fetchone()
            live = row is not None and row['data'] is not None
            if row is None and data is None:
                continue  # deleting something the server never had
            if row is not None and not stamp > row['updated_at']:
                stale.add(plan_id)  # the server has the same or a newer version
                continue
            if data is not None and live:
                # An edit of a plan the server has: keep any field it left out
                # (an older version of the app drops ones it doesn't know).
                merged = keep_missing_fields(row['data'], data)
                if merged is not data:
                    encoded = json.dumps(merged, separators=(',', ':'))
                    if len(encoded) > MAX_PLAN_BYTES:
                        stale.add(plan_id)  # too large with them: the server keeps its copy
                        continue
            if data is None:
                # A deletion from a device whose clock runs ahead would beat
                # later work on other devices: cap its time (but keep it newer
                # than the version it deletes).
                cap = server_stamp(MAX_CLOCK_AHEAD_MS)
                if stamp > cap:
                    stamp = max(cap, stamp_after(row['updated_at'])) if row is not None else cap
            if data is not None and not live:
                live_plans = conn.execute(
                    'SELECT COUNT(*) FROM plans WHERE user_id = ? AND data IS NOT NULL', (user['id'],)
                ).fetchone()[0]
                if live_plans >= MAX_PLANS:
                    raise ApiError(413, 'This account has too many plans.')
            rev += 1
            saved.add(plan_id)
            conn.execute(
                'INSERT INTO plans (user_id, id, data, rev, updated_at) VALUES (?, ?, ?, ?, ?) '
                'ON CONFLICT (user_id, id) DO UPDATE SET '
                'data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at',
                (user['id'], plan_id, encoded, rev, stamp),
            )
        conn.execute('UPDATE users SET rev = ? WHERE id = ?', (rev, user['id']))

        rows = conn.execute(
            'SELECT id, data FROM plans WHERE user_id = ? AND rev > ? ORDER BY rev',
            (user['id'], 0 if body.get('full') is True else cursor),
        ).fetchall()
        seen = {row['id'] for row in rows}
        for plan_id in stale - seen:  # the client's copy lost: send the current one
            row = conn.execute(
                'SELECT id, data FROM plans WHERE user_id = ? AND id = ?', (user['id'], plan_id)
            ).fetchone()
            rows.append(row)

    remote = [
        {'id': row['id'], 'data': json.loads(row['data']) if row['data'] is not None else None}
        for row in rows
        if row['id'] not in saved  # the client already has what it just saved
    ]
    payload = {'epoch': epoch, 'cursor': rev, 'changes': remote}
    if user['is_admin']:
        payload['pending'] = count_pending(conn)  # keeps the admin's badge current
    return 200, payload, []


def schedule_order(meeting):
    """Soonest first: by date, then time (untimed ones last in their day), then id.

    Meetings without a date come after all the others.
    """
    def text(key):
        value = meeting.get(key)
        return value if isinstance(value, str) else ''
    return (not text('dueDate'), text('dueDate'), text('dueTime') or '24:00', meeting['id'])


def api_schedule(conn, environ, body):
    """The admin's meetings, read-only, for every signed-in account (the admin too).

    Response: {"meetings": [{"id": "...", "kind": "meeting", "title": "...", "dueDate": "...", ...}]}

    This is all that approved accounts which aren't the admin can see. Only
    plans the admin saved as meetings are shared, never their other plans,
    and only the fields in SCHEDULE_FIELDS (a field that isn't stored is left
    out). Meetings of an admin account that has been turned off are not shared.

    A meeting's resume and cover letter come as {"id", "name", "size"}; the
    PDF itself is at GET /api/files/<id> (see api_get_file).
    """
    user = current_user(conn, environ)
    if user is None:
        raise ApiError(401, 'Please sign in again.')

    rows = conn.execute(
        'SELECT plans.id, plans.data FROM plans JOIN users ON users.id = plans.user_id '
        "WHERE users.is_admin = 1 AND users.status = 'active' AND plans.data IS NOT NULL"
    ).fetchall()
    meetings = []
    for row in rows:
        try:
            data = json.loads(row['data'])
        except (TypeError, ValueError):
            continue  # not readable: skip it rather than fail the whole schedule
        if not isinstance(data, dict) or data.get('kind') != 'meeting':
            continue
        meeting = {key: data[key] for key in SCHEDULE_FIELDS if key in data}
        meeting['id'] = row['id']
        meetings.append(meeting)
    meetings.sort(key=schedule_order)
    return 200, {'meetings': meetings}, []


# -------------------------------------------------------------------- files

def clean_file_name(raw):
    """A safe name to keep and show for an uploaded PDF.

    `raw` is the X-File-Name header: the file's original name, URL-encoded.
    Any folders, control characters and quotes are removed, the name is cut to
    MAX_FILE_NAME characters, and it always ends with .pdf.
    """
    name = unquote(raw or '')
    name = re.split(r'[/\\]', name)[-1]  # only the name, never a path
    # Control characters, invisible formatting ones (which can make a name
    # read backwards, say), line breaks and quotes.
    name = ''.join(
        ch for ch in name
        if unicodedata.category(ch) not in ('Cc', 'Cf', 'Cs', 'Zl', 'Zp') and ch not in '"\''
    ).strip()
    if name.lower().endswith('.pdf'):
        stem, extension = name[:-4], name[-4:]
    else:
        stem, extension = name, '.pdf'
    stem = stem[:MAX_FILE_NAME - len(extension)].strip()
    return stem + extension if stem else DEFAULT_FILE_NAME


def inline_disposition(name):
    """A Content-Disposition header that shows the PDF in the browser under its own name.

    filename= is a plain-ASCII stand-in for old browsers; filename*= has the
    real name (UTF-8, percent-encoded).
    """
    plain = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode('ascii')
    plain = ''.join(ch for ch in plain if ch.isprintable() and ch not in '"\\')
    plain = ' '.join(plain.split())  # no double spaces where a character was dropped
    if not plain or plain.lower() == '.pdf':
        plain = DEFAULT_FILE_NAME
    return "inline; filename=\"{}\"; filename*=UTF-8''{}".format(plain, quote(name, safe=''))


def attached_to_meeting(conn, owner_id, file_id):
    """Whether one of the account's meetings has this file as its resume or cover letter."""
    rows = conn.execute(
        'SELECT data FROM plans WHERE user_id = ? AND data IS NOT NULL AND instr(data, ?) > 0',
        (owner_id, file_id),
    ).fetchall()
    for row in rows:
        try:
            data = json.loads(row['data'])
        except (TypeError, ValueError):
            continue
        if not isinstance(data, dict) or data.get('kind') != 'meeting':
            continue
        for key in ('resume', 'coverLetter'):
            document = data.get(key)
            if isinstance(document, dict) and document.get('id') == file_id:
                return True
    return False


def forget_unused_files(conn, user_id):
    """Deletes the account's files that no plan of it has mentioned for
    KEEP_UNUSED_SECONDS (an attachment that was replaced or removed, or whose
    meeting was deleted), so they don't pile up.

    The clock starts when a file is first seen unused, and stops again if a
    plan mentions it again (an undone delete, a restored backup). Files newer
    than UNUSED_FILE_SECONDS are never counted as unused: the plan that uses
    one may not have been synced yet.
    """
    now = int(time.time())
    used = (
        'EXISTS (SELECT 1 FROM plans WHERE plans.user_id = files.user_id AND plans.data IS NOT NULL '
        'AND instr(plans.data, files.id) > 0)'
    )
    with conn:
        conn.execute(
            'UPDATE files SET unused_since = NULL WHERE user_id = ? AND unused_since IS NOT NULL AND ' + used,
            (user_id,),
        )
        conn.execute(
            'UPDATE files SET unused_since = ? WHERE user_id = ? AND unused_since IS NULL AND created_at < ? '
            'AND NOT ' + used,
            (now, user_id, now - UNUSED_FILE_SECONDS),
        )
        conn.execute(
            'DELETE FROM files WHERE user_id = ? AND unused_since IS NOT NULL AND unused_since < ?',
            (user_id, now - KEEP_UNUSED_SECONDS),
        )


def api_upload_file(conn, environ, body):
    """Saves one PDF (a meeting's resume or cover letter) for the signed-in admin.

    Request:  the file itself, sent as Content-Type: application/pdf, with its
              original name URL-encoded in the X-File-Name header.
    Response: 201 {"id": "<32 hex characters>", "name": "resume.pdf", "size": <bytes>}

    The browser then saves the meeting with that {"id", "name", "size"} as its
    resume or coverLetter. Only admins upload; other accounts only view.
    Each upload first clears out this account's files that no plan mentions
    any more (see forget_unused_files).
    """
    user = require_planner(conn, environ)
    if not body.startswith(b'%PDF-'):
        raise ApiError(400, 'This file is not a PDF.')
    name = clean_file_name(environ.get('HTTP_X_FILE_NAME', ''))
    forget_unused_files(conn, user['id'])

    file_id = secrets.token_hex(16)
    with conn:
        # Check the limits and save in one locked step, so two uploads at once can't both squeeze in.
        conn.execute('BEGIN IMMEDIATE')
        count, total = conn.execute(
            'SELECT COUNT(*), COALESCE(SUM(size), 0) FROM files WHERE user_id = ?', (user['id'],)
        ).fetchone()
        cleared = 'PDFs that no meeting has used for 30 days are cleared when you upload.'
        if count >= MAX_FILES:
            raise ApiError(413, 'This account already keeps {} files, the most it can. {}'.format(MAX_FILES, cleared))
        if total + len(body) > MAX_ACCOUNT_FILE_BYTES:
            room = MAX_ACCOUNT_FILE_BYTES // (1024 * 1024)
            raise ApiError(413, 'This account has no room for this file ({} MB of PDFs at most). {}'.format(room, cleared))
        conn.execute(
            'INSERT INTO files (id, user_id, name, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            (file_id, user['id'], name, len(body), body, int(time.time())),
        )
    return 201, {'id': file_id, 'name': name, 'size': len(body)}, []


def api_get_file(conn, environ, body, file_id):
    """Sends a stored PDF (GET /api/files/<id>) to whoever may see it.

    The account that uploaded it can always open it. Any other signed-in
    account can open it only while one of the uploader's meetings has it as
    its resume or cover letter (and the uploader is an active admin), so
    taking it off the meeting takes it away. Everything else gets 404, the
    same as a file that doesn't exist, so nobody learns which files exist.
    """
    user = current_user(conn, environ)
    if user is None:
        raise ApiError(401, 'Please sign in again.')
    row = conn.execute(
        'SELECT files.user_id, files.name, users.is_admin, users.status FROM files '
        'JOIN users ON users.id = files.user_id WHERE files.id = ?',
        (file_id,),
    ).fetchone()
    allowed = row is not None and (
        row['user_id'] == user['id']
        or (row['is_admin'] and row['status'] == 'active' and attached_to_meeting(conn, row['user_id'], file_id))
    )
    if not allowed:
        raise ApiError(404, 'Not found.')
    data = conn.execute('SELECT data FROM files WHERE id = ?', (file_id,)).fetchone()['data']
    return 200, bytes(data), [
        ('Content-Type', 'application/pdf'),
        ('Content-Disposition', inline_disposition(row['name'])),
        ('Cache-Control', 'private, no-store'),
    ]


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
            conn.execute('DELETE FROM files WHERE user_id = ?', (target['id'],))
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
    '/api/schedule': {'GET': api_schedule},
    '/api/admin/users': {'GET': api_admin_users, 'POST': api_admin_update_user},
    '/api/admin/settings': {'POST': api_admin_settings},
    '/api/files': {'POST': api_upload_file},
}
# Paths with a part that changes. Each named part of the pattern is passed
# to the endpoint as a keyword argument.
PATTERN_ROUTES = (
    (re.compile(r'/api/files/(?P<file_id>[0-9a-f]{32})'), {'GET': api_get_file, 'HEAD': api_get_file}),
)
# POST endpoints whose body is a file of this type (at most MAX_FILE_BYTES)
# instead of JSON (at most MAX_BODY_BYTES). The endpoint gets the raw bytes.
UPLOADS = {'/api/files': 'application/pdf'}


def find_route(path):
    """The endpoints for a path by method, and the parts of the path they take ((None, {}) if none)."""
    if path in ROUTES:
        return ROUTES[path], {}
    for pattern, route in PATTERN_ROUTES:
        match = pattern.fullmatch(path)
        if match:
            return route, match.groupdict()
    return None, {}


# ------------------------------------------------------------------- WSGI

def check_same_origin(environ, expected='application/json'):
    """Blocks requests sent from other websites (CSRF).

    A page on another site can't send a body of type `expected` (JSON, or a
    PDF for uploads) without asking this server first (a CORS preflight),
    which it never allows; and a request that says where it comes from must
    come from this site.
    """
    content_type = environ.get('CONTENT_TYPE', '').split(';')[0].strip().lower()
    if content_type != expected:
        raise ApiError(415, 'Expected JSON.' if expected == 'application/json' else 'Only PDF files can be uploaded.')
    origin = environ.get('HTTP_ORIGIN')
    host = environ.get('HTTP_HOST')
    if origin and host and urlsplit(origin).netloc.lower() != host.lower():
        raise ApiError(403, 'Cross-site request blocked.')


def content_length(environ, limit, too_large):
    """The request body's declared length, refused (413) when it is over `limit`."""
    try:
        length = int(environ.get('CONTENT_LENGTH') or 0)
    except ValueError:
        raise ApiError(400, 'Invalid request.')
    if length > limit:
        raise ApiError(413, too_large)
    return length


def read_upload(environ):
    """The raw bytes of an uploaded file."""
    length = content_length(
        environ, MAX_FILE_BYTES, 'PDF files can be up to {} MB.'.format(MAX_FILE_BYTES // (1024 * 1024))
    )
    return environ['wsgi.input'].read(length) if length > 0 else b''


def read_json(environ):
    length = content_length(environ, MAX_BODY_BYTES, 'Request too large.')
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
        route, params = find_route(path)
        if route is None:
            raise ApiError(404, 'Not found.')
        endpoint = route.get(method)
        if endpoint is None:
            headers.append(('Allow', ', '.join(route)))
            raise ApiError(405, 'Method not allowed.')
        body = {}
        if method == 'POST':
            upload_type = UPLOADS.get(path)
            check_same_origin(environ, upload_type or 'application/json')
            body = read_upload(environ) if upload_type else read_json(environ)
        conn = connect()
        try:
            status, payload, extra = endpoint(conn, environ, body, **params)
        finally:
            conn.close()
        # A header the endpoint sets (a file's Content-Type, say) replaces the default one.
        replaced = {name.lower() for name, _ in extra}
        headers = [header for header in headers if header[0].lower() not in replaced] + list(extra)
    except ApiError as err:
        status, payload = err.status, {'error': err.message}
    except Exception:  # never leak details; the traceback goes to the error log
        traceback.print_exc(file=sys.stderr)
        status, payload = 500, {'error': 'Something went wrong on the server.'}

    # Endpoints answer with JSON, except a file download, which gives its bytes.
    data = payload if isinstance(payload, bytes) else json.dumps(payload).encode('utf-8')
    headers.append(('Content-Length', str(len(data))))
    start_response('{} {}'.format(status, STATUS_TEXT.get(status, 'Error')), headers)
    return [b''] if method == 'HEAD' else [data]


STATUS_TEXT = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Payload Too Large',
    415: 'Unsupported Media Type', 429: 'Too Many Requests', 500: 'Internal Server Error',
}


# -------------------------------------------------------------------- CLI

def read_new_password(email):
    """Asks twice for a new password; None if it's too short or doesn't match."""
    password = getpass.getpass('New password for {}: '.format(email))
    if len(password) < MIN_PASSWORD:
        print('Use at least {} characters.'.format(MIN_PASSWORD))
        return None
    if getpass.getpass('Type it again: ') != password:
        print('The passwords did not match. Nothing was changed.')
        return None
    return password


def main(argv):
    usage = (
        'Usage:\n'
        '  python3 dayplan_api.py list-users\n'
        '  python3 dayplan_api.py approve EMAIL\n'
        '  python3 dayplan_api.py set-password EMAIL     (existing account)\n'
        '  python3 dayplan_api.py add-user EMAIL         (new, active account)\n'
        '  python3 dayplan_api.py make-admin EMAIL       (creates the account if needed)\n'
        '  python3 dayplan_api.py new-epoch              (after restoring the database file)'
    )
    if len(argv) == 2 and argv[1] == 'new-epoch':
        conn = connect()
        with conn:
            conn.execute("DELETE FROM settings WHERE key = 'epoch'")
        database_epoch(conn)
        print('Done. Every browser will reload its plans from the server on its next sync.')
        return 0
    if len(argv) == 2 and argv[1] == 'list-users':
        conn = connect()
        rows = conn.execute('SELECT email, status, is_admin FROM users ORDER BY id').fetchall()
        for row in rows:
            print('{:<40} {}{}'.format(row['email'], row['status'], ' (admin)' if row['is_admin'] else ''))
        if not rows:
            print('No accounts yet.')
        return 0
    if len(argv) == 3 and argv[1] == 'make-admin':
        email = argv[2].strip().lower()
        conn = connect()
        if not EMAIL_RE.match(email):
            print('That does not look like an email address.')
            return 1
        if not conn.execute('SELECT 1 FROM users WHERE email = ?', (email,)).fetchone():
            print('There is no account for {} yet, so one will be created.'.format(email))
            password = read_new_password(email)
            if password is None:
                return 1
            set_password(conn, email, password, status='active', admin=True)
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
    if len(argv) == 3 and argv[1] in ('set-password', 'add-user'):
        email = argv[2].strip().lower()
        if not EMAIL_RE.match(email):
            print('That does not look like an email address.')
            return 1
        conn = connect()
        exists = conn.execute('SELECT 1 FROM users WHERE email = ?', (email,)).fetchone()
        if argv[1] == 'set-password' and not exists:
            print('No account with that email (check for typos). Run list-users to see all accounts,')
            print('or add-user to create a new one.')
            return 1
        if argv[1] == 'add-user' and exists:
            print('That account already exists. Use set-password to change its password.')
            return 1
        password = read_new_password(email)
        if password is None:
            return 1
        set_password(conn, email, password, status='active', admin=count_users(conn) == 0)
        if exists:
            print('Password changed for {}. Any old sign-ins for this account were ended.'.format(email))
        else:
            print('Account created for {}. They can sign in now.'.format(email))
        return 0
    print(usage)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
