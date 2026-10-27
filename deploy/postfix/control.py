"""Privileged control of one fixed Postfix instance, over a private Unix socket.

No shell, caller-supplied paths, general flush, service control or mail bodies.
The web process stays unprivileged. Installation supplies a root-owned config.
"""
import argparse
import contextlib
import email.parser
import http.server
import json
import os
import pathlib
import re
import signal
import socket
import socketserver
import uuid
import stat
import subprocess
import threading
import time

IDENTIFIER = re.compile(r'^[a-f0-9]{32}$')
QUEUE_ID = re.compile(r'^[A-Za-z0-9]{5,128}$')


def message_metadata(source, arrival_ms, lifetime_ms):
    # postcat may include section markers; only the actual header is parsed.
    lines = source.splitlines()
    markers = [i for i, line in enumerate(lines) if line.startswith('*** MESSAGE CONTENTS')]
    if markers:
        lines = lines[markers[0] + 1:]
    lines = [line for line in lines if not line.startswith('*** ')]
    header = email.parser.Parser().parsestr('\n'.join(lines), headersonly=True)
    def single(name):
        values = header.get_all(name, [])
        return values[0].strip() if len(values) == 1 else None
    code_id = single('X-Forma-Code-Id')
    context_id = single('X-Forma-Context-Id')
    valid = code_id and IDENTIFIER.fullmatch(code_id) and context_id and IDENTIFIER.fullmatch(context_id)
    valid = valid and single('Message-ID') == '<forma-code-' + code_id + '@juxtaposition.ru>'
    deadline = arrival_ms + lifetime_ms
    if valid:
        try:
            requested = int(single('X-Forma-Discard-At'))
            deadline = min(deadline, requested)
        except (TypeError, ValueError):
            valid = False
    return {'codeId': code_id if valid else None, 'contextId': context_id if valid else None,
            'discardAt': deadline}


class Control:
    def __init__(self, config_dir, lifetime_ms, run=None):
        self.config_dir = config_dir
        self.lifetime_ms = lifetime_ms
        self.run = run or self._run
        self.lock = threading.RLock()
        self.deadline = None

    @contextlib.contextmanager
    def bounded_pass(self):
        previous = self.deadline
        if previous is None:
            self.deadline = time.monotonic() + 30
        try:
            yield
        finally:
            self.deadline = previous

    def _run(self, name, arguments, source=None):
        timeout = 10 if self.deadline is None else min(10, self.deadline - time.monotonic())
        if timeout <= 0:
            raise RuntimeError('Postfix inspection budget exceeded')
        result = subprocess.run(['/usr/sbin/' + name, '-c', self.config_dir] + arguments,
                                input=None if source is None else source.encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False)
        if result.returncode or len(result.stdout) > 4 * 1024 * 1024:
            raise RuntimeError('Postfix control command failed')
        return result.stdout.decode('utf-8', errors='replace')

    def snapshot(self):
        rows = {}
        for line in self.run('postqueue', ['-j']).splitlines():
            row = json.loads(line)
            queue_id = row.get('queue_id', '')
            if not isinstance(queue_id, str) or not QUEUE_ID.fullmatch(queue_id):
                raise RuntimeError('Invalid Postfix queue snapshot')
            rows[queue_id] = row
        return rows

    @staticmethod
    def split_headers(source, expected):
        headers, current, lines = {}, None, []
        for line in source.splitlines():
            start = re.fullmatch(r'\*\*\* ENVELOPE RECORDS (.+) \*\*\*', line)
            end = re.fullmatch(r'\*\*\* MESSAGE FILE END (.+) \*\*\*', line)
            if start:
                if current is not None:
                    raise RuntimeError('Incomplete Postfix header batch')
                current, lines = start.group(1).split('/')[-1], []
                if current not in expected or current in headers:
                    raise RuntimeError('Unexpected Postfix header batch')
            elif end:
                if current is None or end.group(1).split('/')[-1] != current:
                    raise RuntimeError('Invalid Postfix header boundary')
                headers[current], current = '\n'.join(lines), None
            elif current is not None:
                lines.append(line)
        if current is not None or set(headers) != set(expected):
            raise RuntimeError('Incomplete Postfix header batch')
        return headers

    def headers(self, rows):
        headers, ids = {}, list(rows)
        for offset in range(0, len(ids), 256):
            remaining = ids[offset:offset + 256]
            for attempt in range(3):
                try:
                    # Envelope markers delimit records; -h explicitly excludes the body.
                    output = self.run('postcat', ['-e', '-h', '-q'] + remaining)
                except RuntimeError:
                    current = self.snapshot()
                    retained = [queue_id for queue_id in remaining if queue_id in current]
                    if retained == remaining:
                        raise  # Persistent inspection failure is not an empty queue.
                    remaining = retained
                    if not remaining:
                        break
                    if attempt == 2:
                        raise RuntimeError('Queue changed throughout inspection')
                    continue
                headers.update(self.split_headers(output, remaining))
                break
        return headers

    def entry(self, queue_id, row, header):
        arrival = int(row['arrival_time']) * 1000
        return {'queueId': queue_id, 'state': row['queue_name'], 'arrivedAt': arrival,
                'messageBytes': int(row['message_size']),
                **message_metadata(header, arrival, self.lifetime_ms)}

    def entries(self):
        with self.lock, self.bounded_pass():
            rows = self.snapshot()
            return [self.entry(queue_id, rows[queue_id], header) for queue_id, header in self.headers(rows).items()]

    def execute(self, request):
        with self.lock, self.bounded_pass():
            action = request.get('action')
            if action == 'list':
                return {'entries': self.entries()}
            if action not in ('delete', 'send'):
                raise ValueError('Unknown control action')
            queue_id, code_id = request.get('queueId', ''), request.get('codeId', '')
            if not isinstance(queue_id, str) or not QUEUE_ID.fullmatch(queue_id):
                raise ValueError('Invalid queue ID')
            if not isinstance(code_id, str) or not IDENTIFIER.fullmatch(code_id):
                raise ValueError('Invalid code ID')
            rows = self.snapshot()
            if queue_id not in rows:
                return {'accepted': action == 'delete'}
            headers = self.headers({queue_id: rows[queue_id]})
            if queue_id not in headers:
                return {'accepted': action == 'delete'}
            metadata = self.entry(queue_id, rows[queue_id], headers[queue_id])
            if metadata['codeId'] != code_id:
                raise ValueError('Queue ownership mismatch')
            if action == 'delete':
                self.run('postsuper', ['-d', queue_id])
            else:
                if metadata['discardAt'] <= int(time.time() * 1000):
                    self.run('postsuper', ['-d', queue_id])
                    return {'accepted': False}
                if metadata['state'] == 'hold':
                    self.run('postsuper', ['-H', queue_id])
                self.run('postqueue', ['-i', queue_id])
            return {'accepted': True}

    def sweep(self):
        with self.lock, self.bounded_pass():
            rows = self.snapshot()
            now = int(time.time() * 1000)
            old = [queue_id for queue_id, row in rows.items() if int(row['arrival_time']) * 1000 + self.lifetime_ms <= now]
            if old:
                # Native expiry alone cannot clean HOLD; delete old files before reading headers.
                self.run('postsuper', ['-d', '-'], '\n'.join(old) + '\n')
                for queue_id in old:
                    del rows[queue_id]
            early = [queue_id for queue_id, header in self.headers(rows).items()
                     if self.entry(queue_id, rows[queue_id], header)['discardAt'] <= int(time.time() * 1000)]
            if early:
                self.run('postsuper', ['-d', '-'], '\n'.join(early) + '\n')


def report_service_failure(config, reason):
    """Best-effort safe fact to the application's one writer; no spool or stdout."""
    target = config.get('journalSocketPath')
    if not isinstance(target, str) or not pathlib.Path(target).is_absolute() or reason not in ('process', 'cleanup'):
        return False
    event = {'event': 'service_failed', 'component': 'postfix', 'reason': reason,
             'eventId': str(uuid.uuid4()), 'occurredAt': int(time.time() * 1000)}
    deadline = time.monotonic() + 1
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            def remaining_timeout():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Service report deadline reached')
                connection.settimeout(remaining)
            remaining_timeout()
            connection.connect(target)
            remaining_timeout()
            connection.sendall((json.dumps(event) + '\n').encode())
            reply = b''
            while len(reply) < 2:
                remaining_timeout()
                part = connection.recv(2 - len(reply))
                if not part:
                    return False
                reply += part
            return time.monotonic() <= deadline and reply == b'1\n'
    except (OSError, ValueError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    options = parser.parse_args()
    config_path = pathlib.Path(options.config)
    config_stat = config_path.stat()
    if config_stat.st_uid != 0 or config_stat.st_mode & 0o022:
        raise RuntimeError('Control configuration must be root-owned and not writable by other users')
    config = json.loads(config_path.read_text())
    try:
        serve(config)
    except Exception:
        report_service_failure(config, 'process')
        raise


def serve(config):
    control = Control(config['postfixConfig'], config['mailLifetimeMs'])
    socket_path = pathlib.Path(config['socketPath'])
    socket_path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    parent = socket_path.parent.stat()
    if parent.st_uid != 0 or parent.st_mode & 0o022:
        raise RuntimeError('Socket directory must be protected from the application user')
    if socket_path.exists():
        if not stat.S_ISSOCK(socket_path.lstat().st_mode):
            raise RuntimeError('Refusing to replace a non-socket path')
        socket_path.unlink()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            try:
                length = int(self.headers.get('Content-Length', '-1'))
                if self.path != '/' or length < 0 or length > 2048:
                    raise ValueError('Invalid request')
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict):
                    raise ValueError('Invalid request')
                result = control.execute(request)
                status = 200
            except (ValueError, TypeError, KeyError):
                status, result = 400, {'error': 'invalid_control_request'}
            except Exception:
                status, result = 503, {'error': 'postfix_unavailable'}
            payload = json.dumps(result).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    class Server(socketserver.UnixStreamServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(10)
            return connection, address

    server = Server(str(socket_path), Handler)
    os.chown(socket_path, config['clientUid'], config['clientGid'])
    os.chmod(socket_path, 0o600)
    stopping = threading.Event()

    def cleanup():
        while not stopping.is_set():
            try:
                control.sweep()
            except Exception:
                # No secret/header/SMTP body is logged. Service supervision owns restart.
                report_service_failure(config, 'cleanup')
                server.shutdown()  # The service manager restarts the fixed instance.
                return
            stopping.wait(config['cleanupIntervalMs'] / 1000)

    def terminate(_signal, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    managed = config.get('startPostfix') is True
    worker = threading.Thread(target=cleanup, daemon=True)
    try:
        if managed:
            control.run('postfix', ['start'])
        # SMTP stays deferred until the application validates and releases a code.
        control.sweep()
        worker.start()
        server.serve_forever()
    finally:
        stopping.set()
        server.server_close()
        if worker.is_alive():
            worker.join(timeout=10)
        if managed:
            try:
                control.run('postfix', ['stop'])
            except RuntimeError:
                pass
        socket_path.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
