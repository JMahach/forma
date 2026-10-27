import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('forma_postfix_install', ROOT / 'deploy/postfix/install.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ServiceReplacementTests(unittest.TestCase):
    def test_first_install_starts_only_after_files_are_ready(self):
        commands = []
        def run(*args):
            commands.append(args)
            if args[1:3] == ('print', 'system/ru.juxtaposition.forma-postfix'):
                raise subprocess.CalledProcessError(113, args)
        with patch.object(MODULE, 'run', side_effect=run):
            MODULE.stop_service('Darwin', '/Library/LaunchDaemons/ru.juxtaposition.forma-postfix.plist')
            self.assertEqual(len(commands), 1)
            MODULE.start_service('Darwin', '/Library/LaunchDaemons/ru.juxtaposition.forma-postfix.plist')
        self.assertEqual(commands[-1], ('/bin/launchctl', 'bootstrap', 'system', '/Library/LaunchDaemons/ru.juxtaposition.forma-postfix.plist'))

    def test_mac_update_unloads_registered_service_before_bootstrap(self):
        commands = []
        with patch.object(MODULE, 'run', side_effect=lambda *args: commands.append(args)):
            MODULE.stop_service('Darwin', '/Library/LaunchDaemons/ru.juxtaposition.forma-postfix.plist')
            MODULE.start_service('Darwin', '/Library/LaunchDaemons/ru.juxtaposition.forma-postfix.plist')
        self.assertEqual([item[1] for item in commands], ['print', 'bootout', 'bootstrap'])
        self.assertEqual(commands[1][2], 'system/ru.juxtaposition.forma-postfix')

    def test_failed_mac_probe_does_not_stop_or_replace_service(self):
        with patch.object(MODULE, 'run', side_effect=subprocess.CalledProcessError(1, ['launchctl'])) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                MODULE.stop_service('Darwin', '/Library/LaunchDaemons/ru.juxtaposition.forma-postfix.plist')
            self.assertEqual(run.call_count, 1)

    def test_linux_reloads_updated_unit_before_starting(self):
        commands = []
        with tempfile.TemporaryDirectory() as directory:
            unit = pathlib.Path(directory) / 'forma-postfix.service'
            with patch.object(MODULE, 'run', side_effect=lambda *args: commands.append(args)):
                MODULE.stop_service('Linux', unit)
                self.assertEqual(commands, [])
                unit.write_text('[Service]\n')
                MODULE.stop_service('Linux', unit)
                MODULE.start_service('Linux', unit)
        self.assertEqual(commands, [('/usr/bin/systemctl', 'stop', 'forma-postfix.service'),
            ('/usr/bin/systemctl', 'daemon-reload'), ('/usr/bin/systemctl', 'enable', '--now', 'forma-postfix.service')])


class ServiceReadinessTests(unittest.TestCase):
    def test_absent_control_socket_cannot_be_reported_as_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'did not become ready'):
                MODULE.wait_service(pathlib.Path(directory) / 'absent.sock', timeout=0)

    def test_real_private_queue_answer_is_required_after_registration(self):
        import http.server
        import socketserver
        import threading
        import json
        with tempfile.TemporaryDirectory() as directory:
            socket_path = pathlib.Path(directory) / 'control.sock'
            class Handler(http.server.BaseHTTPRequestHandler):
                def log_message(self, *_args): pass
                def do_POST(self):
                    self.server.request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    payload = b'{"entries":[]}'
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(payload)))
                    self.end_headers(); self.wfile.write(payload)
            with socketserver.UnixStreamServer(str(socket_path), Handler) as server:
                worker = threading.Thread(target=server.handle_request)
                worker.start()
                try:
                    MODULE.wait_service(socket_path, timeout=2)
                    self.assertEqual(server.request, {'action': 'list'})
                finally: worker.join(timeout=3)
