"""Prepare the existing Linux storage layout before starting a release.

Run after stopping the web service and preparation jobs, first for the old
release when importing legacy prepared data, then for the new release. Prepared
files must already belong to forma and be owner-readable; this step never
repairs their ownership or permissions automatically. No generation, service restart,
account reset, deletion of conflicting data, or release switch is performed.
"""
import argparse
import json
import os
import pathlib
import platform
import pwd
import stat

STATE = pathlib.Path('/var/lib/forma')
JOURNAL = pathlib.Path('/var/log/forma')
CACHE = pathlib.Path('/var/cache/forma')


def directory_or_absent(path):
    if path.is_symlink() or path.exists() and not path.is_dir():
        raise ValueError('Expected a real directory or an unused path: ' + str(path))


def private_directory(path, uid, gid):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chown(path, uid, gid)
    path.chmod(0o700)


def check_prepared_access(directory, uid):
    # Inspect metadata only. Never follow links or read the multi-GB payload.
    pending = [directory] if directory.exists() else []
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                info = entry.stat(follow_symlinks=False)
                is_directory = stat.S_ISDIR(info.st_mode)
                if not is_directory and not stat.S_ISREG(info.st_mode):
                    raise ValueError('Prepared data must contain only real files and directories: ' + entry.path)
                if info.st_uid != uid:
                    raise PermissionError(f'Prepared data must belong to application UID {uid}; '
                                          f'found UID {info.st_uid}: {entry.path}. Correct this file explicitly.')
                required = 0o500 if is_directory else 0o400
                if info.st_mode & required != required:
                    raise PermissionError('Prepared data must be owner-readable and directories traversable: ' + entry.path)
                if is_directory:
                    pending.append(pathlib.Path(entry.path))


def prepare_storage(release, uid, gid, *, apply=False):
    release = pathlib.Path(release).resolve(strict=True)
    server_present = any((release / 'server' / name).is_file()
                         for name in ('server.ts', 'server.mjs'))
    if not (release / 'package.json').is_file() or not server_present:
        raise ValueError('Choose a complete current or legacy Forma release')
    cache_link_root = release / '.cache'
    for folder in (STATE, JOURNAL, CACHE, cache_link_root):
        directory_or_absent(folder)
    actions = []
    # Validate every destination before changing any existing path.
    for name in ('lifetime', 'returns'):
        source, target = cache_link_root / name, CACHE / name
        directory_or_absent(target)
        if source.is_symlink():
            if source.resolve() != target.resolve():
                raise ValueError('Prepared data points outside its expected zone: ' + str(source))
            action = 'keep_link'
        else:
            directory_or_absent(source)
            populated = source.exists() and any(source.iterdir())
            if populated and target.exists() and any(target.iterdir()):
                raise ValueError('Both prepared directories contain data; inspect them before proceeding: ' + name)
            if populated:
                ancestor = target.parent
                while not ancestor.exists():
                    ancestor = ancestor.parent
                if source.stat().st_dev != ancestor.stat().st_dev:
                    raise ValueError('Cross-filesystem data transfer needs an explicit verified copy: ' + name)
            action = 'move_directory' if populated else 'link'
        actions.append({'source': str(source), 'target': str(target), 'action': action})
    # Validate the preserved contents before even creating state/journal zones.
    for row in actions:
        check_prepared_access(pathlib.Path(row['source'] if row['action'] == 'move_directory' else row['target']), uid)
    if not apply:
        return actions
    for folder in (STATE, JOURNAL, CACHE):
        private_directory(folder, uid, gid)
    cache_link_root.mkdir(exist_ok=True, mode=0o750)
    # Root installs these links; the application group must traverse their
    # parent even under umask 077 or when repairing an earlier private parent.
    os.chown(cache_link_root, -1, gid)
    cache_link_root.chmod(0o750)
    for row in actions:
        source, target = pathlib.Path(row['source']), pathlib.Path(row['target'])
        if row['action'] == 'move_directory':
            if target.exists():
                target.rmdir()  # Validated empty; a concurrent new file makes this fail safely.
            source.rename(target)  # Same filesystem: preserve bytes and inode, never duplicate 6 GB.
        elif row['action'] == 'link' and source.exists():
            source.rmdir()  # Never delete non-empty data.
        private_directory(target, uid, gid)
        if row['action'] != 'keep_link':
            source.symlink_to(target, target_is_directory=True)
    return actions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True, type=pathlib.Path)
    parser.add_argument('--apply', action='store_true')
    options = parser.parse_args()
    if platform.system() != 'Linux':
        raise RuntimeError('This installation step is for Linux only')
    user = pwd.getpwnam('forma')
    if user.pw_uid == 0:
        raise RuntimeError('The application user must be unprivileged')
    if options.apply and os.geteuid() != 0:
        raise RuntimeError('Applying the system layout requires root')
    print(json.dumps({'applied': options.apply, 'actions': prepare_storage(
        options.release, user.pw_uid, user.pw_gid, apply=options.apply)}, indent=2))


if __name__ == '__main__':
    main()
