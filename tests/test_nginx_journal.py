"""Actual proxy filtering when nginx is installed; never touches a service unit."""
import http.client
import http.server
import pathlib
import re
import socket
import subprocess
import tempfile
import threading
import time
import unittest

from tests.test_nginx_limits import NGINX, ROOT


@unittest.skipUnless(NGINX, 'native nginx is not installed')
class ProxyJournalTests(unittest.TestCase):
    def test_only_failures_before_headers_emit_status_without_request_details(self):
        class Upstream(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                slow = self.path.startswith('/slow')
                if slow:
                    time.sleep(.2)
                status = 200 if slow else int(self.path.split('?')[0][1:])
                self.send_response(status)
                self.send_header('Content-Length', '0')
                try:
                    self.end_headers()
                except BrokenPipeError:
                    pass

            def log_message(self, *_args):
                pass

        upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        proxy = None
        try:
            with tempfile.TemporaryDirectory(prefix='forma-nginx-journal-', dir='/tmp') as directory:
                folder = pathlib.Path(directory)
                with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as received, socket.socket() as reservation:
                    received.bind(str(folder / 'nginx.sock'))
                    received.settimeout(.1)
                    reservation.bind(('127.0.0.1', 0))
                    port = reservation.getsockname()[1]
                    reservation.close()
                    source = (ROOT / 'deploy/forma.nginx').read_text()
                    config = source[:source.index('server {')] + source[source.index('server {\n    listen 443 ssl;'):]
                    config = config.replace('listen 443 ssl;', f'listen 127.0.0.1:{port};')
                    config = re.sub(r'^    ssl_.*\n', '', config, flags=re.MULTILINE)
                    config = config.replace('127.0.0.1:4173', f'127.0.0.1:{upstream.server_port}')
                    config = config.replace('/run/forma-journal/nginx.sock', str(folder / 'nginx.sock'))
                    config = config.replace('proxy_read_timeout 65s;', 'proxy_read_timeout 50ms;')
                    filename = folder / 'nginx.conf'
                    filename.write_text(f'pid {folder}/pid;\nerror_log stderr warn;\ndaemon off;\nmaster_process off;\n'
                                        + 'events {worker_connections 64;}\nhttp {\n' + config + '\n}\n')
                    with (folder / 'error.log').open('w+') as errors:
                        proxy = subprocess.Popen([NGINX, '-p', directory, '-c', str(filename)], stdout=errors, stderr=errors)
                        deadline = time.monotonic() + 5
                        while True:
                            try:
                                with socket.create_connection(('127.0.0.1', port), timeout=.1):
                                    break
                            except OSError:
                                if proxy.poll() is not None or time.monotonic() > deadline:
                                    errors.seek(0)
                                    self.fail('Temporary nginx failed: ' + errors.read())
                                time.sleep(.01)

                        def request(route):
                            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                            try:
                                connection.request('GET', route, headers={'Cookie': 'PRIVATE'})
                                response = connection.getresponse()
                                response.read()
                                return response.status
                            finally:
                                connection.close()

                        for status in (200, 502, 504):
                            self.assertEqual(request(f'/{status}?PRIVATE'), status)
                            with self.assertRaises(TimeoutError):
                                received.recv(257)
                        self.assertEqual(request('/slow?PRIVATE'), 504)
                        self.assertRegex(received.recv(257), rb'forma_proxy: 504\n?$')
                        upstream.shutdown()
                        upstream.server_close()
                        self.assertEqual(request('/PRIVATE'), 502)
                        packet = received.recv(257)
                        self.assertRegex(packet, rb'forma_proxy: 502\n?$')
                        self.assertNotIn(b'PRIVATE', packet)
        finally:
            if proxy is not None:
                proxy.terminate()
                try:
                    proxy.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proxy.kill()
                    proxy.wait()
            upstream.shutdown()
            upstream.server_close()


if __name__ == '__main__':
    unittest.main()
