"""One-time removal of the legacy transit archive through anchored directory FDs."""
import errno
import json
import os
import re
import stat
import sys

PACKET = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\.[a-f0-9]{16}\.gz\Z")
TEMP = re.compile(r"\.[0-9]{4}-[0-9]{2}-[0-9]{2}\.[a-f0-9]{16}\.gz\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp\Z")
VERSION = re.compile(r"v[0-9]+\Z")
SUPPORTED = (os.name == 'posix' and hasattr(os, 'O_NOFOLLOW') and hasattr(os, 'O_DIRECTORY')
             and os.open in os.supports_dir_fd and os.unlink in os.supports_dir_fd
             and os.stat in os.supports_dir_fd and os.stat in os.supports_follow_symlinks
             and os.listdir in os.supports_fd)
FLAGS = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)


def open_directory(directory):
    """Open every path component without following a link, starting at the OS root."""
    descriptor = os.open('/', FLAGS)
    try:
        for component in directory.split('/'):
            if not component or component == '.':
                continue
            child = os.open(component, FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def cleanup(directory):
    result = dict(removed=0, blocked=0, reason='complete')
    if not SUPPORTED:
        return dict(result, blocked=1, reason='unsupported')
    if (not isinstance(directory, str) or not directory.startswith('/') or chr(0) in directory
            or '..' in directory.split('/')):
        return dict(result, blocked=1, reason='invalid_input')

    def blocked(reason):
        result['blocked'] += 1
        if result['reason'] == 'complete':
            result['reason'] = reason

    def clean(descriptor, versions):
        try:
            names = os.listdir(descriptor)
        except OSError:
            blocked('io_error')
            return
        for name in names:
            if PACKET.fullmatch(name) or TEMP.fullmatch(name):
                try:
                    entry = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                    if stat.S_ISREG(entry.st_mode):
                        # Replacement with a symlink cannot redirect unlinkat: it
                        # removes only this name in the already opened directory.
                        os.unlink(name, dir_fd=descriptor)
                        result['removed'] += 1
                    elif stat.S_ISLNK(entry.st_mode):
                        blocked('unsafe_entry')
                except FileNotFoundError:
                    pass
                except OSError:
                    blocked('io_error')
            elif versions and VERSION.fullmatch(name):
                try:
                    child = os.open(name, FLAGS, dir_fd=descriptor)
                except FileNotFoundError:
                    continue
                except OSError as error:
                    blocked('unsafe_entry' if error.errno in (errno.ELOOP, errno.ENOTDIR) else 'io_error')
                    continue
                try:
                    clean(child, False)
                finally:
                    os.close(child)

    try:
        descriptor = open_directory(directory)
    except FileNotFoundError:
        return dict(result, reason='missing')
    except OSError as error:
        return dict(result, blocked=1, reason='unsafe_path' if error.errno in (errno.ELOOP, errno.ENOTDIR) else 'io_error')
    try:
        clean(descriptor, True)
    finally:
        os.close(descriptor)
    return result


if __name__ == '__main__':
    try:
        source = sys.stdin.read(16385)
        request = json.loads(source) if len(source) <= 16384 else None
        result = cleanup(request.get('directory')) if isinstance(request, dict) else dict(removed=0, blocked=1, reason='invalid_input')
    except (ValueError, TypeError):
        result = dict(removed=0, blocked=1, reason='invalid_input')
    print(json.dumps(result, separators=(',', ':')))
