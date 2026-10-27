"""Consume native Postfix delivery receipts through a private, local pipe.

The pipe runs as the application's Unix user and receives native null-sender DSNs
only. No HTTP endpoint accepts receipts. Postfix retains a receipt until this
process commits its terminal outcome; temporary database failures return EX_TEMPFAIL.
The original message body and remote SMTP diagnostic are never stored here.
"""
import argparse
import email.parser
import email.policy
import pathlib
import json
import re
import sqlite3
import sys
import time

IDENTIFIER = re.compile(r'^[a-f0-9]{32}$')
QUEUE_ID = re.compile(r'^[A-Za-z0-9]{5,128}$')
STATUS = re.compile(r'^[245]\.\d{1,3}\.\d{1,3}$')
MAX_RECEIPT_BYTES = 65536


def single(message, name):
    values = message.get_all(name, [])
    return str(values[0]).strip() if len(values) == 1 else None


def parse_receipt(source):
    if len(source) > MAX_RECEIPT_BYTES:
        return None
    message = email.parser.BytesParser(policy=email.policy.default).parsebytes(source)
    if message.defects or message.get_content_type() != 'multipart/report' or message.get_param('report-type') != 'delivery-status':
        return None
    reports = [part for part in message.iter_parts() if part.get_content_type() in ('message/delivery-status', 'message/global-delivery-status')]
    if len(reports) != 1 or reports[0].defects:
        return None
    blocks = reports[0].get_payload()
    # Python treats global-delivery-status as one generic message. Its body is
    # the recipient block, while classic delivery-status already yields two blocks.
    if reports[0].get_content_type() == 'message/global-delivery-status':
        if not isinstance(blocks, list) or len(blocks) != 1:
            return None
        envelope = blocks[0]
        recipient_source = envelope.get_payload(decode=True)
        if not isinstance(recipient_source, bytes):
            return None
        recipient = email.parser.BytesParser(policy=email.policy.default).parsebytes(recipient_source)
        if recipient.is_multipart() or str(recipient.get_payload()).strip():
            return None
        blocks = [envelope, recipient]
    # Each code mail has exactly one recipient. Ambiguous reports remain unknown.
    if not isinstance(blocks, list) or len(blocks) != 2 or any(block.defects for block in blocks):
        return None
    envelope, recipient = blocks
    code_id, queue_id = single(envelope, 'Original-Envelope-ID'), single(envelope, 'X-Postfix-Queue-ID')
    action, status = single(recipient, 'Action'), single(recipient, 'Status')
    if not code_id or not IDENTIFIER.fullmatch(code_id) or not queue_id or not QUEUE_ID.fullmatch(queue_id):
        return None
    if not status or not STATUS.fullmatch(status) or not single(recipient, 'Final-Recipient'):
        return None
    if action in ('relayed', 'delivered') and status.startswith('2.'):
        outcome = 'handed_off'
    elif action == 'failed' and (status.startswith('5.') or status == '4.4.7'):
        outcome = 'expired' if status == '4.4.7' else 'rejected'
    else:
        return None
    return {'codeId': code_id, 'queueId': queue_id, 'outcome': outcome, 'reason': 'dsn:' + status}


def consume(database, sender, source, now_ms=None):
    if sender != '<>':
        return 0
    receipt = parse_receipt(source.read(MAX_RECEIPT_BYTES + 1))
    if receipt is None:
        return 0
    completed_at = int(time.time() * 1000) if now_ms is None else now_ms
    try:
        # Never silently create a second database when installation points at a bad path.
        connection = sqlite3.connect(pathlib.Path(database).resolve().as_uri() + '?mode=rw', uri=True,
                                     timeout=5, isolation_level=None)
        try:
            connection.execute('BEGIN IMMEDIATE')
            connection.execute('''UPDATE mail_queue SET queueId = coalesce(queueId, ?), outcome = ?, completedAt = ?, reason = ?
                WHERE id = ? AND outcome IS NULL AND (queueId IS NULL OR queueId = ?)''',
                (receipt['queueId'], receipt['outcome'], completed_at, receipt['reason'], receipt['codeId'], receipt['queueId']))
            connection.execute('COMMIT')
        finally:
            connection.close()
    except sqlite3.Error:
        return 75  # Postfix keeps the native receipt and retries; no second body is submitted.
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    location = parser.add_mutually_exclusive_group(required=True)
    location.add_argument('--database')
    location.add_argument('--config')
    parser.add_argument('--sender', required=True)
    options = parser.parse_args()
    database = options.database
    if options.config:
        try:
            database = json.loads(pathlib.Path(options.config).read_text())['database']
        except (OSError, ValueError, KeyError):
            return 75
    return consume(database, options.sender, sys.stdin.buffer)


if __name__ == '__main__':
    sys.exit(main())
