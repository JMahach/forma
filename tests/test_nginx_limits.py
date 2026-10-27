"""Native proxy regression; synthetic upstream, no production routes or data."""
import concurrent.futures
import http.client
import http.server
import pathlib
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
NGINX = shutil.which('nginx') or ('/usr/sbin/nginx' if pathlib.Path('/usr/sbin/nginx').exists() else None)


@unittest.skipUnless(NGINX, 'native nginx is not installed')
class CalculationAdmissionTests(unittest.TestCase):
    def check_batch(self, paths, check_overflow=False):
        size = len(paths)
        release = threading.Event()
        entered = threading.Condition()
        count = 0

        class Upstream(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                nonlocal count
                self.rfile.read(int(self.headers.get('Content-Length', '0')))
                with entered:
                    count += 1
                    entered.notify_all()
                release.wait(10)
                self.send_response(200)
                self.send_header('Content-Length', '2')
                self.end_headers()
                self.wfile.write(b'{}')

            do_GET = do_POST

            def log_message(self, *_args):
                pass

        upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix='forma-nginx-') as directory:
                folder = pathlib.Path(directory)
                with socket.socket() as reservation:
                    reservation.bind(('127.0.0.1', 0))
                    port = reservation.getsockname()[1]
                source = (ROOT / 'deploy/forma.nginx').read_text()
                # Keep the production zones and all application locations; only
                # replace the test listener/upstream and omit TLS/HTTP redirect.
                https = source.index('server {\n    listen 443 ssl;')
                config = source[:source.index('server {')] + source[https:]
                config = config.replace('listen 443 ssl;', f'listen 127.0.0.1:{port};')
                config = re.sub(r'^    ssl_.*\n', '', config, flags=re.MULTILINE)
                config = config.replace('127.0.0.1:4173', f'127.0.0.1:{upstream.server_port}')
                (folder / 'nginx.conf').write_text(
                    f'pid {folder}/nginx.pid;\nerror_log stderr warn;\ndaemon off;\nmaster_process off;\n'
                    + 'events { worker_connections 128; }\nhttp {\n' + config + '\n}\n')
                with (folder / 'error.log').open('w+') as log:
                    proxy = subprocess.Popen([NGINX, '-p', directory, '-c', str(folder / 'nginx.conf')],
                                             stdout=log, stderr=log)
                    try:
                        deadline = time.monotonic() + 5
                        while True:
                            try:
                                with socket.create_connection(('127.0.0.1', port), timeout=.1):
                                    break
                            except OSError:
                                if proxy.poll() is not None or time.monotonic() > deadline:
                                    log.seek(0)
                                    self.fail('Temporary nginx did not start: ' + log.read())
                                time.sleep(.01)

                        def request(route):
                            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=12)
                            try:
                                connection.request('GET' if route == '/api/versions' else 'POST', route, body='{}',
                                                   headers={'Content-Type': 'application/json'})
                                response = connection.getresponse()
                                response.read()
                                return response.status
                            finally:
                                connection.close()

                        with concurrent.futures.ThreadPoolExecutor(max_workers=size + 1) as clients:
                            futures = [clients.submit(request, route) for route in paths]
                            try:
                                with entered:
                                    ready = entered.wait_for(lambda: count == size, timeout=2)
                                self.assertTrue(ready, f'Only {count}/{size} normal requests reached the existing queue')
                                if check_overflow:
                                    self.assertIn(clients.submit(request, '/api/calculate').result(timeout=2), (429, 503),
                                                  'The proxy must still bound excess work')
                            finally:
                                release.set()
                            self.assertEqual([future.result() for future in futures], [200] * size)
                    finally:
                        release.set()
                        proxy.terminate()
                        proxy.wait(timeout=5)
        finally:
            release.set()
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=5)

    def test_five_main_returns_fit_one_panel_open(self):
        self.check_batch(['/api/cycles/events'] * 5)

    def test_full_panel_plus_selected_chart_day_and_form_fit_with_an_ordinary_read(self):
        # The four offline availability probes read device storage, not HTTP.
        # One normal GET also verifies the server limit is not a hidden ceiling
        # on the location's separately counted compute requests.
        self.check_batch(['/api/cycles/events'] * 13 + ['/api/cycles/chart',
                         '/api/chart/day', '/api/calculate', '/api/versions'], check_overflow=True)


if __name__ == '__main__':
    unittest.main()
