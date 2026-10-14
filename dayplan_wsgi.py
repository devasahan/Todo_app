"""WSGI entry point for hosting Dayplan on PythonAnywhere (or any WSGI host).

Dayplan is a static site, so this only hands out its files: the page itself
plus everything under css/ and js/. Nothing else in the repository (README,
tests, .git, ...) is reachable.

On PythonAnywhere, point the web app's WSGI configuration file here:

    import sys
    sys.path.insert(0, '/home/YOUR_USERNAME/Todo_app')
    from dayplan_wsgi import application
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC_DIRS = ('css', 'js')
CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
}


def find_file(url_path):
    """Maps a URL path to a public file, or returns None."""
    if url_path in ('', '/', '/index.html'):
        return ROOT / 'index.html'
    parts = url_path.lstrip('/').split('/')
    if len(parts) < 2 or parts[0] not in PUBLIC_DIRS:
        return None
    if any(part in ('', '.', '..') or part.startswith('.') for part in parts):
        return None
    try:
        file = ROOT.joinpath(*parts).resolve()
    except (OSError, ValueError):
        return None
    inside = file.is_relative_to(ROOT / parts[0])
    if not inside or file.suffix not in CONTENT_TYPES or not file.is_file():
        return None
    return file


def application(environ, start_response):
    method = environ.get('REQUEST_METHOD', 'GET')
    file = find_file(environ.get('PATH_INFO', '/'))

    if method not in ('GET', 'HEAD'):
        start_response('405 Method Not Allowed', [('Allow', 'GET, HEAD'), ('Content-Type', 'text/plain')])
        return [b'Method not allowed']
    if file is None:
        start_response('404 Not Found', [('Content-Type', 'text/plain')])
        return [b'Not found']

    body = file.read_bytes()
    start_response('200 OK', [
        ('Content-Type', CONTENT_TYPES[file.suffix]),
        ('Content-Length', str(len(body))),
        # Always check for a newer copy, so updates show up after a reload.
        ('Cache-Control', 'no-cache'),
        ('X-Content-Type-Options', 'nosniff'),
    ])
    return [b''] if method == 'HEAD' else [body]
