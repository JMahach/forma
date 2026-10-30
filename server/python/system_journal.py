"""Fixed local system facts. No raw logs, durable queue or network listener."""
import argparse
import errno
import json
import os
import pathlib
import re
import signal
import socket
import stat
import sys
import time
import uuid

SYSTEM_COMPONENTS = ('application_service', 'nginx_service', 'postfix_service')
SYSTEM_RESULTS = {'exit-code': 'exit', 'signal': 'signal', 'core-dump': 'signal', 'oom-kill': 'oom',
                  'timeout': 'timeout', 'resources': 'resources', 'watchdog': 'watchdog',
                  'protocol': 'protocol', 'start-limit-hit': 'start_limit'}
PROXY_REASONS = {b'502': 'bad_gateway', b'504': 'gateway_timeout'}
# Nginx supplies no hostname and a fixed tag; even a valid status plus raw text is rejected.
PROXY_FORMAT = re.compile(rb'<[0-9]{1,3}>[A-Z][a-z]{2} {1,2}[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} forma_proxy: (502|504)\n?')
MAX_DATAGRAM_BYTES = 256


def system_failure(component, environment):
    reason = SYSTEM_RESULTS.get(environment.get('SERVICE_RESULT'))
    if component not in SYSTEM_COMPONENTS or not reason:
        return None
    return {'component': component, 'reason': reason}


def nginx_failure(data):
    match = PROXY_FORMAT.fullmatch(data) if len(data) <= MAX_DATAGRAM_BYTES else None
    return {'component': 'nginx_proxy', 'reason': PROXY_REASONS[match[1]]} if match else None


def _valid_fact(fact):
    if not isinstance(fact, dict) or set(fact) != {'component', 'reason'}:
        return False
    reasons = PROXY_REASONS.values() if fact['component'] == 'nginx_proxy' else (
        SYSTEM_RESULTS.values() if fact['component'] in SYSTEM_COMPONENTS else ())
    return fact['reason'] in reasons


def _remaining(connection, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('Delivery deadline')
    connection.settimeout(remaining)


def _receive_ack(connection, deadline):
    reply = b''
    while len(reply) < 2:
        _remaining(connection, deadline)
        part = connection.recv(3 - len(reply))
        if not part:
            return False
        reply += part
    return reply == b'1\n'


def send_fact(address, fact):
    if not _valid_fact(fact):
        return False
    frame = json.dumps({'event': 'service_failed', **fact, 'eventId': str(uuid.uuid4()),
                        'occurredAt': int(time.time() * 1000)}, separators=(',', ':')).encode() + b'\n'
    try:
        deadline = time.monotonic() + 1
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            _remaining(connection, deadline)
            connection.connect(address)
            _remaining(connection, deadline)
            connection.sendall(frame)
            return _receive_ack(connection, deadline)
    except (OSError, ValueError):
        return False


def _private_directory(parent):
    parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        raise PermissionError('Unsafe source directory')
    if info.st_mode & 0o027:
        raise PermissionError('Unsafe source directory permissions')
    # BSD/macOS can inherit the temp parent's group. Only an already verified
    # directory owned by this process is assigned its configured service group.
    if info.st_gid != os.getegid():
        os.chown(parent, -1, os.getegid())
    parent.chmod(0o750)


def _reclaim(address):
    try:
        previous = address.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(previous.st_mode) or previous.st_uid != os.geteuid():
        raise PermissionError('Unsafe source socket')
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as probe:
        probe.settimeout(1)
        try:
            probe.connect(str(address))
        except OSError as error:
            if error.errno != errno.ECONNREFUSED:
                raise
        else:
            raise FileExistsError('Source socket already owned')
    current = address.lstat()
    if (current.st_dev, current.st_ino) != (previous.st_dev, previous.st_ino):
        raise FileExistsError('Source socket changed')
    address.unlink()


class DatagramInput:
    def __init__(self, filename):
        self.address = pathlib.Path(filename)
        self.identity = None
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            if not self.address.is_absolute():
                raise ValueError('Source socket must be absolute')
            _private_directory(self.address.parent)
            _reclaim(self.address)
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 64 * 1024)
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 16 * 1024)
            self.reserved_socket_bytes = sum(self.socket.getsockopt(socket.SOL_SOCKET, option)
                                             for option in (socket.SO_RCVBUF, socket.SO_SNDBUF))
            if self.reserved_socket_bytes > 1024 * 1024:
                raise OSError('Source socket exceeds its reservation')
            self.socket.bind(str(self.address))
            info = self.address.lstat()
            self.identity = (info.st_dev, info.st_ino)
            self.address.chmod(0o620)
        except BaseException:
            self.close()
            raise

    def receive(self):
        return self.socket.recv(MAX_DATAGRAM_BYTES + 1)

    def close(self):
        self.socket.close()
        if self.identity is None:
            return
        try:
            info = self.address.lstat()
            if self.identity == (info.st_dev, info.st_ino):
                self.address.unlink()
        except FileNotFoundError:
            pass
        self.identity = None


def notify_ready(environment):
    address = environment.get('NOTIFY_SOCKET')
    if not address:
        return
    if address[0] not in ('/', '@'):
        raise ValueError('Unsupported notification socket')
    if address[0] == '@':
        address = '\0' + address[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as connection:
        connection.settimeout(1)
        connection.connect(address)
        connection.sendall(b'READY=1')


def _stop(_signum, _frame):
    raise SystemExit(0)


def serve(address, writer):
    receiver = DatagramInput(address)
    try:
        signal.signal(signal.SIGTERM, _stop)
        signal.signal(signal.SIGINT, _stop)
        # Node starts this child only after the sole writer and stream input are ready.
        notify_ready(os.environ)
        print('READY', flush=True)
        while True:
            fact = nginx_failure(receiver.receive())
            if fact:
                send_fact(writer, fact)
    finally:
        receiver.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    listener = commands.add_parser('listen')
    listener.add_argument('--socket', required=True)
    listener.add_argument('--writer', required=True)
    stop = commands.add_parser('stop')
    stop.add_argument('--component', choices=SYSTEM_COMPONENTS, required=True)
    stop.add_argument('--writer', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'listen':
            serve(args.socket, args.writer)
            return 0
        fact = system_failure(args.component, os.environ)
        return 0 if fact is None or send_fact(args.writer, fact) else 1
    except (OSError, ValueError):
        print('Forma system source unavailable', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
