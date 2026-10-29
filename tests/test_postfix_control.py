import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('forma_postfix_control', ROOT / 'deploy/postfix/control.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PostfixControlTests(unittest.TestCase):
    def test_header_metadata_has_a_deadline_capped_by_actual_arrival(self):
        headers = 'Received: by local\nX-Forma-Code-Id: ' + 'a' * 32 + '\nX-Forma-Context-Id: ' + 'b' * 32 + '\nX-Forma-Discard-At: 999999999\nMessage-ID: <forma-code-' + 'a' * 32 + '@juxtaposition.ru>\n\n'
        data = MODULE.message_metadata(headers, 1000, 300000)
        self.assertEqual(data['discardAt'], 301000)
        self.assertEqual(data['codeId'], 'a' * 32)
        self.assertNotIn('body', data)

    def test_conflicting_headers_and_wrong_message_id_are_not_trusted(self):
        headers = 'X-Forma-Code-Id: ' + 'a' * 32 + '\nX-Forma-Code-Id: ' + 'b' * 32 + '\n\n'
        self.assertIsNone(MODULE.message_metadata(headers, 1000, 300000)['codeId'])

    def test_control_rejects_queue_id_injection_and_mismatched_message(self):
        commands = []
        def run(name, args):
            commands.append((name, args))
            if name == 'postqueue': return QueueInspectionTests.row('ValidQueueId')
            return ('*** ENVELOPE RECORDS hold/ValidQueueId ***\n'
                    + '*** MESSAGE CONTENTS hold/ValidQueueId ***\n'
                    + 'X-Forma-Code-Id: ' + 'b' * 32 + '\n\n'
                    + '*** MESSAGE FILE END hold/ValidQueueId ***\n')
        control = MODULE.Control('/private/forma-postfix', 300000, run=run)
        with self.assertRaises(ValueError):
            control.execute({'action': 'delete', 'queueId': '../ALL', 'codeId': 'a' * 32})
        self.assertEqual(commands, [])
        with self.assertRaises(ValueError):
            control.execute({'action': 'delete', 'queueId': 'ValidQueueId', 'codeId': 'a' * 32})
        self.assertTrue(all(name != 'postsuper' for name, _args in commands))

    def test_general_flush_and_arbitrary_commands_are_not_available(self):
        control = MODULE.Control('/private/forma-postfix', 300000, run=lambda *_: '')
        for action in ['flush-all', 'start', 'stop', 'shell', 'write']:
            with self.assertRaises(ValueError):
                control.execute({'action': action})


class QueueInspectionTests(unittest.TestCase):
    @staticmethod
    def row(queue_id='Queue1', arrival=1000):
        import json
        return json.dumps({'queue_id': queue_id, 'queue_name': 'hold', 'arrival_time': arrival, 'message_size': 1000}) + '\n'

    def test_failed_inspection_is_not_an_empty_queue(self):
        def run(name, args, source=None):
            if name == 'postqueue': return self.row()
            raise RuntimeError('Access denied')
        with self.assertRaises(RuntimeError):
            MODULE.Control('/fixed', 300000, run=run).execute({'action': 'list'})

    def test_only_a_fresh_snapshot_can_prove_a_file_disappeared(self):
        snapshots = iter([self.row(), ''])
        def run(name, args, source=None):
            if name == 'postqueue': return next(snapshots)
            raise RuntimeError('File disappeared')
        self.assertEqual(MODULE.Control('/fixed', 300000, run=run).execute({'action': 'list'}), {'entries': []})

    def test_expired_files_are_removed_before_any_header_inspection(self):
        from unittest.mock import patch
        commands = []
        def run(name, args, source=None):
            commands.append((name, args, source))
            if name == 'postqueue': return self.row(arrival=1)
            if name == 'postcat': raise RuntimeError('Headers unavailable')
            return ''
        with patch.object(MODULE.time, 'time', return_value=1000):
            MODULE.Control('/fixed', 300000, run=run).sweep()
        self.assertIn(('postsuper', ['-d', '-'], 'Queue1\n'), commands)
        self.assertFalse(any(name == 'postcat' for name, _args, _source in commands))

    def test_one_batch_reads_multiple_headers_and_never_requests_bodies(self):
        commands = []
        def section(queue_id):
            return ('*** ENVELOPE RECORDS hold/' + queue_id + ' ***\n'
                    + '*** MESSAGE CONTENTS hold/' + queue_id + ' ***\n'
                    + 'X-Forma-Code-Id: ' + 'a' * 32 + '\nX-Forma-Context-Id: ' + 'b' * 32
                    + '\nX-Forma-Discard-At: 1300000\nMessage-ID: <forma-code-' + 'a' * 32 + '@juxtaposition.ru>\n\n'
                    + '*** MESSAGE FILE END hold/' + queue_id + ' ***\n')
        def run(name, args, source=None):
            commands.append((name, args))
            if name == 'postqueue': return self.row() + self.row('Queue2')
            return section('Queue1') + section('Queue2')
        entries = MODULE.Control('/fixed', 300000, run=run).execute({'action': 'list'})['entries']
        self.assertEqual([entry['queueId'] for entry in entries], ['Queue1', 'Queue2'])
        self.assertEqual([args for name, args in commands if name == 'postcat'], [['-e', '-h', '-q', 'Queue1', 'Queue2']])


    def test_partial_batch_is_not_treated_as_complete(self):
        with self.assertRaises(RuntimeError):
            MODULE.Control.split_headers('*** ENVELOPE RECORDS hold/Queue1 ***\nX: y\n', ['Queue1'])

    def test_an_exhausted_pass_cannot_start_another_subprocess(self):
        control = MODULE.Control('/fixed', 300000)
        control.deadline = MODULE.time.monotonic() - 1
        with self.assertRaisesRegex(RuntimeError, 'budget'):
            control._run('postqueue', ['-j'])


    @unittest.skipUnless(pathlib.Path('/usr/sbin/postcat').exists(), 'Native Postfix is unavailable')
    def test_native_postcat_boundaries_match_and_message_bodies_are_excluded(self):
        import subprocess
        import tempfile
        def record(kind, text):
            content = text.encode()
            self.assertLess(len(content), 128)  # Single-byte lengths in this small synthetic queue fixture.
            return kind.encode() + bytes([len(content)]) + content
        with tempfile.TemporaryDirectory(prefix='forma-native-header-test-') as directory:
            files = []
            for name in ['Queue1', 'Queue2']:
                target = pathlib.Path(directory) / name
                rows = [('T', '1000'), ('S', 'forma@juxtaposition.ru'), ('R', 'person@example.invalid'), ('M', ''),
                        ('N', 'X-Forma-Code-Id: ' + 'a' * 32), ('N', 'X-Forma-Context-Id: ' + 'b' * 32),
                        ('N', 'X-Forma-Discard-At: 1300000'),
                        ('N', 'Message-ID: <forma-code-' + 'a' * 32 + '@juxtaposition.ru>'),
                        ('N', ''), ('N', 'SYNTHETIC_BODY_NOT_FOR_HEADERS'), ('X', ''), ('E', '')]
                target.write_bytes(b''.join(record(kind, value) for kind, value in rows))
                files.append(str(target))
            result = subprocess.run(['/usr/sbin/postcat', '-e', '-h'] + files, check=True, capture_output=True, text=True)
            self.assertNotIn('SYNTHETIC_BODY_NOT_FOR_HEADERS', result.stdout)
            headers = MODULE.Control.split_headers(result.stdout, ['Queue1', 'Queue2'])
            self.assertEqual(MODULE.message_metadata(headers['Queue1'], 1000000, 300000)['codeId'], 'a' * 32)


class ServiceReportDeadlineTests(unittest.TestCase):
    def test_fragmented_ack_cannot_extend_the_total_attempt_deadline(self):
        import socket
        import tempfile
        import threading
        import time
        # Keep the Unix socket path short on macOS; use the system temp root elsewhere.
        root = '/tmp' if sys.platform == 'darwin' else tempfile.gettempdir()
        with tempfile.TemporaryDirectory(dir=root, prefix='forma-deadline-') as directory:
            target = str(pathlib.Path(directory) / 'input.sock')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(target)
                listener.listen(1)
                listener.settimeout(3)
                def respond():
                    with listener.accept()[0] as peer:
                        peer.recv(1024)
                        try:
                            time.sleep(0.7)
                            peer.sendall(b'1')
                            time.sleep(0.7)
                            peer.sendall(b'\n')
                        except OSError:
                            pass  # A deadline closes the client before the second byte.
                worker = threading.Thread(target=respond, daemon=True)
                worker.start()
                started = time.monotonic()
                accepted = MODULE.report_service_failure({'journalSocketPath': target}, 'cleanup')
                elapsed = time.monotonic() - started
                worker.join(timeout=3)
                self.assertFalse(worker.is_alive())
                self.assertFalse(accepted, 'A late second byte must not acknowledge the report')
                self.assertLess(elapsed, 1.25)  # Scheduling tolerance, not another I/O budget.


if __name__ == '__main__':
    unittest.main()
