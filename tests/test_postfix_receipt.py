import importlib.util
import io
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('forma_postfix_receipt', ROOT / 'deploy/postfix/receipt.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
CODE_ID = 'a' * 32
QUEUE_ID = 'NativeQueue1'


def receipt(action='relayed', status='2.0.0', extra='', envelope_id=CODE_ID):
    # Native Postfix DSN shape: envelope metadata, recipient status, original headers.
    return (f'MIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="report"\r\n\r\n'
            f'--report\r\nContent-Type: text/plain\r\n\r\nUntrusted human-readable detail.\r\n'
            f'--report\r\nContent-Type: message/delivery-status\r\n\r\n'
            f'Reporting-MTA: dns; localhost\r\nX-Postfix-Queue-ID: {QUEUE_ID}\r\nOriginal-Envelope-ID: {envelope_id}\r\n{extra}\r\n'
            f'Final-Recipient: rfc822; person@example.invalid\r\nAction: {action}\r\nStatus: {status}\r\n'
            f'Diagnostic-Code: smtp; 250 arbitrary reply containing a private value\r\n\r\n'
            f'--report\r\nContent-Type: text/rfc822-headers\r\n\r\nMessage-ID: <forma-code-{CODE_ID}@juxtaposition.ru>\r\n'
            f'\r\n--report--\r\n').encode()


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.database = pathlib.Path(self.directory.name) / 'forma.sqlite'
        # Exercise the actual schema and migration, not a copied Python schema.
        script = """import { openDatabase } from './server/storage/database.ts';
import { createMailStorage } from './server/storage/mail-queue.ts';
import { MAIL_POLICY } from './server/mail/policy.ts';
const db = openDatabase(process.argv[1]); const store = createMailStorage(db, MAIL_POLICY);
store.reserve({id: 'a'.repeat(32),contextId:'b'.repeat(32),reservedBytes:1000,createdAt:1000,discardAt:301000});db.close();"""
        subprocess.run(['node', '--input-type=module', '-e', script, str(self.database)], cwd=ROOT,
                       check=True, capture_output=True)

    def row(self):
        with sqlite3.connect(self.database) as db:
            return db.execute('SELECT queueId, outcome, completedAt FROM mail_queue').fetchone()

    def deliver(self, body=None, sender='<>'):
        return MODULE.consume(self.database, sender, io.BytesIO(receipt() if body is None else body), now_ms=2000)

    def test_native_receipt_commits_outcome_and_survives_restart_without_saving_diagnostic(self):
        self.assertEqual(self.deliver(), 0)
        self.assertEqual(self.row(), (QUEUE_ID, 'handed_off', 2000))
        self.assertNotIn(b'private value', self.database.read_bytes())
        with sqlite3.connect(self.database) as db:
            self.assertEqual(db.execute('SELECT reason FROM mail_queue').fetchone(), ('dsn:2.0.0',))
        self.assertEqual(self.deliver(receipt('failed', '5.1.1')), 0)
        self.assertEqual(self.row(), (QUEUE_ID, 'handed_off', 2000), 'First terminal receipt wins')

    def test_smtputf8_native_receipt_has_the_same_terminal_outcome(self):
        body = receipt().replace(b'Content-Type: message/delivery-status', b'Content-Type: message/global-delivery-status')
        body = body.replace(b'rfc822; person@example.invalid', ('utf-8; ' + chr(0x43f) + chr(0x43e) + chr(0x447) + chr(0x442) + chr(0x430) + '@example.invalid').encode())
        self.assertEqual(self.deliver(body), 0)
        self.assertEqual(self.row(), (QUEUE_ID, 'handed_off', 2000))

    def test_receipt_cannot_complete_a_different_queue_binding(self):
        with sqlite3.connect(self.database) as db:
            db.execute('UPDATE mail_queue SET queueId=?', ('OtherQueue2',))
        self.assertEqual(self.deliver(), 0)
        self.assertEqual(self.row(), ('OtherQueue2', None, None))

    def test_failed_expired_and_delayed_are_distinct(self):
        self.assertEqual(MODULE.parse_receipt(receipt('failed', '5.1.1'))['outcome'], 'rejected')
        self.assertEqual(MODULE.parse_receipt(receipt('failed', '4.4.7'))['outcome'], 'expired')
        self.assertIsNone(MODULE.parse_receipt(receipt('delayed', '4.4.1')))
        self.assertEqual(self.deliver(receipt('delayed', '4.4.1')), 0)
        self.assertEqual(self.row(), (None, None, None))

    def test_bad_or_ambiguous_reports_do_not_authorize_an_outcome(self):
        for body in [receipt(extra='Original-Envelope-ID: ' + CODE_ID + '\r\n'),
                     receipt(envelope_id='../../foreign'), receipt('relayed', '5.1.1'),
                     b'Content-Type: text/plain\r\n\r\nAction: relayed', b'x' * 65537]:
            self.assertEqual(self.deliver(body), 0)
            self.assertEqual(self.row(), (None, None, None))
        self.assertEqual(self.deliver(sender='person@example.invalid'), 0)
        self.assertEqual(self.row(), (None, None, None))

    def test_unavailable_database_defers_native_receipt_without_creating_a_new_database(self):
        missing = pathlib.Path(self.directory.name) / 'missing.sqlite'
        self.assertEqual(MODULE.consume(missing, '<>', io.BytesIO(receipt()), now_ms=2000), 75)
        self.assertFalse(missing.exists())

    def test_duplicate_after_reservation_is_consumed_is_acknowledged_without_recreating_it(self):
        with sqlite3.connect(self.database) as db:
            db.execute('DELETE FROM mail_queue')
        self.assertEqual(self.deliver(), 0)
        self.assertIsNone(self.row())


if __name__ == '__main__':
    unittest.main()
