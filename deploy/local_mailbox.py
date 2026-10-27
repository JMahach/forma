"""Local-only Mailpit utility behind the existing Forma Postfix queue.

install prepares a per-user Mac service; run starts the pinned utility with
inherited Mailpit overrides removed. No application, Postfix or DNS is changed.
"""
import argparse
import hashlib
import io
import json
import os
import pathlib
import platform
import plistlib
import subprocess
import tarfile
import time
import urllib.request

VERSION = 'v1.32.0'
LABEL = 'ru.juxtaposition.forma-mailbox'
RELEASES = {
    ('Darwin', 'arm64'): ('darwin-arm64', '23709bd727f20da2290de6a2a40c4685c48a3127586d77370efd1a3a595f9ef6'),
    ('Darwin', 'x86_64'): ('darwin-amd64', 'd7f3d0964cd2ea4c2a7d10660a12e02876718e67d88ced390d9cd90350a453da'),
}


def environment(source):
    # The wrapper owns the whole receiver configuration. In particular a shell
    # cannot silently enable forwarding, a remote database or raw mail logs.
    return {key: value for key, value in source.items() if not key.startswith('MP_')}


def arguments(directory):
    return [str(directory / 'mailpit'), '--listen', '127.0.0.1:8025',
            '--smtp', '127.0.0.1:1025', '--webroot', '/__mail/',
            '--allowed-hosts', '127.0.0.1,localhost', '--smtp-max-recipients', '1',
            '--smtp-tls-cert', str(directory / 'tls.crt'), '--smtp-tls-key', str(directory / 'tls.key'),
            '--smtp-require-starttls', '--smtp-disable-rdns', '--disable-version-check',
            '--block-remote-css-and-fonts', '--quiet', '--max', '500']


def extract_binary(data, expected):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError('Mailpit release checksum mismatch')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        member = archive.getmember('mailpit')
        if not member.isfile() or member.size > 256 * 1024 * 1024:
            raise ValueError('Invalid Mailpit binary')
        return archive.extractfile(member).read()


def launch_agent(directory):
    return {'Label': LABEL, 'ProgramArguments': ['/usr/bin/python3', str(directory / 'local_mailbox.py'), 'run'],
            'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 5,
            'StandardOutPath': '/dev/null', 'StandardErrorPath': '/dev/null'}


def private_directory(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid():
        raise RuntimeError('Local mailbox directory must belong to the current user')
    directory.chmod(0o700)


def write_private(target, data, mode=0o600):
    temporary = target.with_suffix(target.suffix + '.installing')
    with temporary.open('xb') as stream:
        stream.write(data)
    temporary.chmod(mode)
    temporary.replace(target)


def install(directory):
    asset, checksum = RELEASES.get((platform.system(), platform.machine()), (None, None))
    if asset is None:
        raise RuntimeError('Automatic local mailbox installation currently supports macOS only; Linux production uses Postfix')
    private_directory(directory)
    url = f'https://github.com/axllent/mailpit/releases/download/{VERSION}/mailpit-{asset}.tar.gz'
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(64 * 1024 * 1024 + 1)
    binary = extract_binary(data, checksum)
    # Prepare everything before replacing the running utility. Inbox is temporary:
    # a normal stop lets Mailpit delete its database; it is never a production archive.
    certificate, key = directory / 'tls.crt', directory / 'tls.key'
    if not certificate.exists() or not key.exists() or subprocess.run(
            ['/usr/bin/openssl', 'x509', '-checkend', '86400', '-noout', '-in', str(certificate)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        subprocess.run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', str(key), '-out', str(certificate), '-days', '365', '-subj', '/CN=localhost'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        key.chmod(0o600)
    domain = f'gui/{os.getuid()}'
    target = f'{domain}/{LABEL}'
    probe = subprocess.run(['/bin/launchctl', 'print', target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if probe.returncode == 0:
        subprocess.run(['/bin/launchctl', 'bootout', target], check=True)
    elif probe.returncode != 113:
        raise RuntimeError('Cannot inspect local mailbox service')
    write_private(directory / 'mailpit', binary, 0o700)
    write_private(directory / 'local_mailbox.py', pathlib.Path(__file__).read_bytes())
    unit = pathlib.Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    unit.parent.mkdir(parents=True, exist_ok=True)
    write_private(unit, plistlib.dumps(launch_agent(directory)))
    subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(unit)], check=True)
    deadline = time.monotonic() + 10
    while True:
        try:
            with urllib.request.urlopen('http://127.0.0.1:8025/__mail/api/v1/info', timeout=1) as response:
                if response.status == 200:
                    break
        except OSError:
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError('Mailbox service registered but did not become ready')
        time.sleep(0.2)
    print(json.dumps({'utility': 'Mailpit ' + VERSION, 'directory': str(directory),
                      'upstream': 'http://127.0.0.1:8025/__mail/', 'smtp': '127.0.0.1:1025',
                      'storage': 'temporary; removed on normal stop', 'postfixChanged': False,
                      'applicationChanged': False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'run'])
    options = parser.parse_args()
    if os.geteuid() == 0:
        raise RuntimeError('Local mailbox runs as the user, never as root or in production')
    os.umask(0o077)
    directory = pathlib.Path.home() / '.local/share/forma-mailbox'
    if options.action == 'install':
        install(directory)
    else:
        private_directory(directory / 'runtime')
        env = environment(os.environ)
        env['TMPDIR'] = str(directory / 'runtime')
        os.execve(str(directory / 'mailpit'), arguments(directory), env)


if __name__ == '__main__':
    main()
