"""Tests for dayplan_wsgi.py. Run with: python3 -m unittest discover -s tests"""
import sys
import unittest
from pathlib import Path
from wsgiref.util import setup_testing_defaults

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dayplan_wsgi import application  # noqa: E402


def request(path, method='GET'):
    environ = {'PATH_INFO': path, 'REQUEST_METHOD': method}
    setup_testing_defaults(environ)
    environ['PATH_INFO'] = path
    captured = {}

    def start_response(status, headers):
        captured['status'] = status
        captured['headers'] = dict(headers)

    body = b''.join(application(environ, start_response))
    return captured['status'], captured['headers'], body


class ServesTheApp(unittest.TestCase):
    def test_home_page(self):
        for path in ('/', '/index.html'):
            status, headers, body = request(path)
            self.assertEqual(status, '200 OK')
            self.assertEqual(headers['Content-Type'], 'text/html; charset=utf-8')
            self.assertIn(b'<title>Dayplan</title>', body)

    def test_styles_and_scripts(self):
        expected = {
            '/css/styles.css': 'text/css; charset=utf-8',
            '/js/core.js': 'text/javascript; charset=utf-8',
            '/js/app.js': 'text/javascript; charset=utf-8',
        }
        for path, content_type in expected.items():
            status, headers, body = request(path)
            self.assertEqual(status, '200 OK', path)
            self.assertEqual(headers['Content-Type'], content_type)
            self.assertEqual(headers['Content-Length'], str(len(body)))

    def test_head_has_no_body(self):
        status, headers, body = request('/', method='HEAD')
        self.assertEqual(status, '200 OK')
        self.assertEqual(body, b'')
        self.assertNotEqual(headers['Content-Length'], '0')

    def test_other_methods_rejected(self):
        for path in ('/', '/js/' + 'a' * 300 + '.js'):
            status, _, _ = request(path, method='POST')
            self.assertTrue(status.startswith('405'), path)


class KeepsEverythingElsePrivate(unittest.TestCase):
    def test_blocks_non_public_files(self):
        for path in [
            '/README.md',
            '/package.json',
            '/dayplan_wsgi.py',
            '/tests/core.test.js',
            '/.git/config',
            '/js/../README.md',
            '/js/../../etc/passwd',
            '/css/..%2fREADME.md',
            '/js/.hidden.js',
            '/js',
            '/js/',
            '/css//styles.css',
            '/js/core.js\x00.png',
            '/nope.html',
            # Over-long names must be a clean 404, not an OSError.
            '/js/' + 'a' * 300 + '.js',
            '/css/' + 'a' * 300 + '/x.css',
            '/js/' + 'abcdefgh/' * 600 + 'x.js',
        ]:
            status, _, body = request(path)
            self.assertEqual(status, '404 Not Found', path)
            self.assertEqual(body, b'Not found', path)


if __name__ == '__main__':
    unittest.main()
