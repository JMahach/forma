"""Install only the prepared Forma Postfix instance, never the application or DNS.

Default invocation prints the exact target paths. --apply requires root.
No packages are downloaded, application environment changed or email sent.
"""
import argparse
import json
import os
import pathlib
import plistlib
import pwd
import subprocess
import platform
import http.client
import socket
import time

CONFIG = pathlib.Path('/etc/forma-postfix')
SERVICE = pathlib.Path('/var/lib/forma-postfix')
SOCKET = SERVICE / 'run'
FILES = ['main.cf', 'master.cf', 'control.json', 'transports', 'recipient-access', 'environment']


def run(*arguments):
    environment = os.environ.copy()
    if platform.system() == 'Darwin':
        environment['OS_ACTIVITY_MODE'] = 'disable'
    subprocess.run(arguments, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, env=environment)


def stop_service(system, unit_path):
    """Quiesce this instance before replacing configuration and its programs."""
    if system == 'Darwin':
        target = 'system/ru.juxtaposition.forma-postfix'
        try:
            run('/bin/launchctl', 'print', target)
        except subprocess.CalledProcessError as error:
            if error.returncode != 113:  # launchd: service is not registered.
                raise
        else:
            run('/bin/launchctl', 'bootout', target)
    elif pathlib.Path(unit_path).exists():
        run('/usr/bin/systemctl', 'stop', 'forma-postfix.service')


def start_service(system, unit_path):
    if system == 'Darwin':
        run('/bin/launchctl', 'bootstrap', 'system', str(unit_path))
    else:
        run('/usr/bin/systemctl', 'daemon-reload')
        run('/usr/bin/systemctl', 'enable', '--now', 'forma-postfix.service')


def wait_service(socket_path, timeout=30):
    """Service registration is asynchronous; finish only after the queue answers."""
    deadline = time.monotonic() + timeout
    while True:
        connection = http.client.HTTPConnection('localhost', timeout=2)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(2)
        try:
            connection.sock.connect(str(socket_path))
            connection.request('POST', '/', '{"action":"list"}', {'Content-Type': 'application/json'})
            response = connection.getresponse()
            payload = response.read(1048577)
            if response.status == 200 and len(payload) <= 1048576:
                value = json.loads(payload)
                if isinstance(value, dict) and isinstance(value.get('entries'), list):
                    return
        except (OSError, ValueError, http.client.HTTPException):
            pass
        finally:
            connection.close()
        if time.monotonic() >= deadline:
            raise RuntimeError('Postfix was registered but its private queue did not become ready')
        time.sleep(0.25)


def protected_directory(directory):
    directory.mkdir(parents=True, mode=0o755, exist_ok=True)
    for parent in [directory.resolve()] + list(directory.resolve().parents):
        info = parent.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('System installation path is not protected: ' + str(parent))


def write_private(target, source, mode=0o644):
    protected_directory(target.parent)
    temporary = target.with_suffix(target.suffix + '.installing')
    with temporary.open('xb') as stream:
        stream.write(source)
        stream.flush()
        os.fsync(stream.fileno())
    os.chown(temporary, 0, 0)
    os.chmod(temporary, mode)
    temporary.replace(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--apply', action='store_true')
    options = parser.parse_args()
    bundle = pathlib.Path(options.bundle).resolve()
    settings = json.loads((bundle / 'control.json').read_text())
    user = pwd.getpwuid(settings['clientUid'])
    if user.pw_uid == 0 or settings['postfixConfig'] != str(CONFIG) or settings['socketPath'] != str(SOCKET / 'control.sock'):
        raise RuntimeError('Invalid fixed instance configuration')
    database = pathlib.Path(settings['database'])
    if not database.is_file() or database.stat().st_uid != user.pw_uid:
        raise RuntimeError('The existing application database must belong to the chosen unprivileged user')
    system = platform.system()
    if system not in ('Darwin', 'Linux'):
        raise RuntimeError('Unsupported system')
    for name in FILES:
        if not (bundle / name).is_file() or (bundle / name).is_symlink():
            raise RuntimeError('Missing regular configuration file: ' + name)
    for command in ['postconf', 'postfix', 'postqueue', 'postcat', 'postsuper']:
        if not pathlib.Path('/usr/sbin', command).is_file():
            raise RuntimeError('Install the system Postfix package first')
    if system == 'Darwin':
        unit = 'ru.juxtaposition.forma-postfix.plist'
        unit_path = pathlib.Path('/Library/LaunchDaemons', unit)
        plistlib.loads((bundle / unit).read_bytes())
    else:
        unit = 'forma-postfix.service'
        unit_path = pathlib.Path('/etc/systemd/system', unit)
        version = subprocess.check_output(['/usr/bin/systemctl', '--version'], text=True).split()[1]
        if int(version) < 253:
            raise RuntimeError('systemd 253 or later is required for native log filtering')
    print(json.dumps({'configuration': str(CONFIG), 'programs': str(SERVICE / 'libexec'),
                      'queue': '/var/spool/forma-postfix', 'socket': str(SOCKET / 'control.sock'),
                      'database': str(database), 'appUser': user.pw_name, 'service': str(unit_path),
                      'rawLogFilter': 'OS_ACTIVITY_MODE=disable plus /etc/asl.conf (only forma-postfix/local7)' if system == 'Darwin' else 'unit LogFilterPatterns',
                      'changesApplicationEnvironment': False, 'changesDNS': False}, indent=2))
    if not options.apply:
        return
    if os.geteuid() != 0:
        raise RuntimeError('System installation requires administrator privileges; no system files changed')
    # Validate the reviewed bundle with the native parser before touching the installation.
    for flag in ['-n', '-M']:
        run('/usr/sbin/postconf', '-c', str(bundle), flag)
    stop_service(system, unit_path)
    for directory in [CONFIG, SERVICE, SERVICE / 'libexec', SOCKET, pathlib.Path('/var/spool/forma-postfix')]:
        protected_directory(directory)
    for name in FILES:
        write_private(CONFIG / name, (bundle / name).read_bytes())
    for name in ['control.py', 'receipt.py']:
        write_private(SERVICE / 'libexec' / name, pathlib.Path(__file__).with_name(name).read_bytes())
    write_private(unit_path, (bundle / unit).read_bytes())
    if system == 'Darwin':
        asl = pathlib.Path('/etc/asl.conf')
        rule = (bundle / 'asl-rule').read_bytes()
        existing = asl.read_bytes()
        if rule not in existing:
            # Keep one recoverable original system configuration, not a source checkout.
            backup = asl.with_name('asl.conf.before-forma')
            if not backup.exists():
                write_private(backup, existing, 0o600)
            write_private(asl, rule + existing)
            run('/usr/bin/killall', '-HUP', 'syslogd')
    # Native check creates only missing queue/data directories; do not reset
    # permissions of shared system binaries with set-permissions.
    run('/usr/sbin/postfix', '-c', str(CONFIG), 'check')
    start_service(system, unit_path)
    wait_service(settings['socketPath'])
    print('Installed. Application mail stays unconfigured until native queue validation and explicit environment setup.')


if __name__ == '__main__':
    main()
