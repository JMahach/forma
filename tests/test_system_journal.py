import json
import os
import pathlib
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

from server.python.system_journal import nginx_failure, system_failure, send_fact, DatagramInput, notify_ready, main


class FixedSystemFacts(unittest.TestCase):
    def test_system_results_are_fixed_and_ordinary_stops_are_silent(self):
        for result in ('success', 'exec-condition', '', 'PRIVATE'):
            self.assertIsNone(system_failure('application_service', {'SERVICE_RESULT': result}))
        for result, reason in [('exit-code', 'exit'), ('signal', 'signal'), ('core-dump', 'signal'),
                               ('oom-kill', 'oom'), ('timeout', 'timeout'), ('watchdog', 'watchdog'),
                               ('resources', 'resources'), ('protocol', 'protocol'), ('start-limit-hit', 'start_limit')]:
            env = {'SERVICE_RESULT': result, 'EXIT_CODE': 'killed', 'EXIT_STATUS': 'KILL',
                   'MESSAGE': 'PRIVATE', 'INVOCATION_ID': 'PRIVATE'}
            fact = system_failure('application_service', env)
            self.assertEqual(fact, {'component': 'application_service', 'reason': reason})
            self.assertNotIn('PRIVATE', json.dumps(fact))
        self.assertIsNone(system_failure('PRIVATE', {'SERVICE_RESULT': 'exit-code'}))

    def test_nginx_accepts_only_the_status_only_source_format(self):
        for status, reason in [(502, 'bad_gateway'), (504, 'gateway_timeout')]:
            data = f'<187>Oct 30 12:00:00 forma_proxy: {status}'.encode()
            self.assertEqual(nginx_failure(data), {'component': 'nginx_proxy', 'reason': reason})
        for data in [b'502', b'<187>Oct 30 12:00:00 host forma_proxy: 502',
                     b'<187>Oct 30 12:00:00 forma_proxy: 500',
                     b'<187>Oct 30 12:00:00 forma_proxy: 502 GET /PRIVATE',
                     b'<187>Oct 30 12:00:00 forma_proxy: 502\nPRIVATE', b'x' * 257, b'\xff']:
            self.assertIsNone(nginx_failure(data))


class PrivateSystemTransport(unittest.TestCase):
    def setUp(self):
        # macOS AF_UNIX paths are short; the normal user temp root can exceed it.
        self.temporary = tempfile.TemporaryDirectory(prefix='forma-sys-', dir='/tmp')
        self.root = pathlib.Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_delivery_requires_the_real_ack_and_has_no_spool(self):
        address = str(self.root / 'writer.sock')
        self.assertFalse(send_fact(address, {'component': 'nginx_proxy', 'reason': 'bad_gateway'}))
        self.assertEqual(list(self.root.iterdir()), [])
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(address)
            server.listen(1)
            received = []

            def receive():
                for reply in (b'0\n', b'1\n'):
                    connection, _ = server.accept()
                    with connection:
                        received.append(json.loads(connection.recv(1024)))
                        connection.sendall(reply)

            thread = threading.Thread(target=receive)
            thread.start()
            self.assertFalse(send_fact(address, {'component': 'nginx_proxy', 'reason': 'bad_gateway'}))
            self.assertTrue(send_fact(address, {'component': 'nginx_proxy', 'reason': 'bad_gateway'}))
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(received), 2)
            self.assertEqual(set(received[0]), {'event', 'component', 'reason', 'eventId', 'occurredAt'})
            self.assertEqual(received[0]['event'], 'service_failed')

    def test_datagram_socket_is_group_write_only_and_never_replaces_live_or_foreign_paths(self):
        parent = self.root / 'run'
        address = parent / 'nginx.sock'
        first = DatagramInput(str(address))
        try:
            self.assertEqual(parent.stat().st_mode & 0o777, 0o750)
            self.assertEqual(parent.stat().st_gid, os.getegid())
            self.assertEqual(address.stat().st_mode & 0o777, 0o620)
            self.assertLessEqual(first.reserved_socket_bytes, 1024 * 1024)
            with self.assertRaises(OSError):
                DatagramInput(str(address))
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as client:
                client.sendto(b'<187>Oct 30 12:00:00 forma_proxy: 502', str(address))
            self.assertEqual(nginx_failure(first.receive()), {'component': 'nginx_proxy', 'reason': 'bad_gateway'})
        finally:
            first.close()
        self.assertFalse(address.exists())
        address.write_text('PRIVATE')
        with self.assertRaises(OSError):
            DatagramInput(str(address))
        self.assertEqual(address.read_text(), 'PRIVATE')

    def test_stale_datagram_socket_can_be_reclaimed_but_close_preserves_a_replacement(self):
        parent = self.root / 'run'
        parent.mkdir(mode=0o750)
        address = parent / 'nginx.sock'
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as abandoned:
            abandoned.bind(str(address))
        receiver = DatagramInput(str(address))
        address.unlink()
        address.write_text('replacement')
        receiver.close()
        self.assertEqual(address.read_text(), 'replacement')

    def test_ready_notification_uses_one_datagram_without_a_poll(self):
        address = str(self.root / 'notify.sock')
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as target:
            target.bind(address)
            target.settimeout(1)
            notify_ready({'NOTIFY_SOCKET': address})
            self.assertEqual(target.recv(32), b'READY=1')
        notify_ready({})

    def test_stop_command_is_silent_on_success_and_exits_without_retries_when_writer_is_down(self):
        args = ['system_journal.py', 'stop', '--component', 'application_service',
                '--writer', str(self.root / 'absent.sock')]
        with patch('sys.argv', args), patch.dict(os.environ, {'SERVICE_RESULT': 'success'}):
            self.assertEqual(main(), 0)
        with patch('sys.argv', args), patch.dict(os.environ, {'SERVICE_RESULT': 'exit-code'}):
            self.assertEqual(main(), 1)
        self.assertEqual(list(self.root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
