import importlib.util
import pathlib
import tempfile
import unittest
import os
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('forma_prepare_storage', ROOT / 'deploy/prepare-storage.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class LinuxStoragePreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='forma-linux-layout-')
        self.addCleanup(self.temporary.cleanup)
        self.base = pathlib.Path(self.temporary.name).resolve()
        self.release = self.base / 'release'
        (self.release / 'server').mkdir(parents=True)
        (self.release / 'server/server.ts').write_text('// synthetic release')
        (self.release / 'package.json').write_text('{}')
        self.paths = {name: self.base / name for name in ('STATE', 'JOURNAL', 'CACHE')}
        replacements = patch.multiple(MODULE, **self.paths)
        replacements.start()
        self.addCleanup(replacements.stop)

    def prepare(self, apply=True):
        return MODULE.prepare_storage(self.release, os.getuid(), os.getgid(), apply=apply)

    def test_fresh_install_has_separate_private_stores_and_both_prepared_paths(self):
        self.prepare(apply=False)
        self.assertFalse(any(p.exists() for p in self.paths.values()))
        self.assertFalse((self.release / '.cache').exists())
        self.prepare()
        for folder in self.paths.values():
            self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
        for name in ('lifetime', 'returns'):
            link = self.release / '.cache' / name
            self.assertTrue(link.is_symlink())
            self.assertEqual(link.resolve(), self.paths['CACHE'] / name)
        key = self.paths['STATE'] / 'key'
        key.write_bytes(b'EXISTING_KEY')
        self.prepare()
        self.assertEqual(key.read_bytes(), b'EXISTING_KEY')

    def test_existing_prepared_bytes_move_out_of_the_release_without_copying(self):
        old = self.release / '.cache/returns'
        old.mkdir(parents=True)
        binary = old / 'return-index.bin'
        binary.write_bytes(b'PREPARED_TRAJECTORIES')
        inode = binary.stat().st_ino
        self.prepare()
        target = self.paths['CACHE'] / 'returns/return-index.bin'
        self.assertEqual(target.read_bytes(), b'PREPARED_TRAJECTORIES')
        self.assertEqual(target.stat().st_ino, inode)
        self.assertEqual(binary.resolve(), target)
        self.prepare()
        self.assertEqual(target.stat().st_ino, inode)

    def test_restrictive_umask_and_existing_link_directory_allow_application_group_access(self):
        link_root = self.release / '.cache'
        previous_umask = os.umask(0o077)
        try:
            for existing in (False, True):
                with self.subTest(existing=existing):
                    if existing:
                        link_root.chmod(0o700)
                    self.prepare()
                    info = link_root.stat()
                    self.assertEqual(info.st_gid, os.getgid())
                    self.assertEqual(info.st_mode & 0o050, 0o050)
                    self.assertEqual(info.st_mode & 0o007, 0)
                    for folder in [*self.paths.values(),
                                   self.paths['CACHE'] / 'lifetime',
                                   self.paths['CACHE'] / 'returns']:
                        self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
                        self.assertEqual(folder.stat().st_uid, os.getuid())
                    for name in ('lifetime', 'returns'):
                        self.assertEqual((link_root / name).resolve(), self.paths['CACHE'] / name)
        finally:
            os.umask(previous_umask)

    def test_legacy_release_and_new_release_share_the_existing_prepared_data(self):
        (self.release / 'server/server.ts').rename(self.release / 'server/server.mjs')
        old = self.release / '.cache/returns'
        old.mkdir(parents=True)
        binary = old / 'return-index.bin'
        binary.write_bytes(b'PREPARED_TRAJECTORIES')
        inode = binary.stat().st_ino
        self.prepare()
        new_release = self.base / 'new-release'
        (new_release / 'server').mkdir(parents=True)
        (new_release / 'server/server.ts').write_text('// synthetic release')
        (new_release / 'package.json').write_text('{}')
        MODULE.prepare_storage(new_release, os.getuid(), os.getgid(), apply=True)
        new_binary = new_release / '.cache/returns/return-index.bin'
        self.assertEqual(new_binary.read_bytes(), b'PREPARED_TRAJECTORIES')
        self.assertEqual(new_binary.stat().st_ino, inode)
        self.assertEqual(binary.resolve(), new_binary.resolve())

    def test_conflicting_copies_are_rejected_before_other_storage_changes(self):
        old = self.release / '.cache/returns'
        old.mkdir(parents=True)
        (old / 'return-index.bin').write_bytes(b'RELEASE_DATA')
        target = self.paths['CACHE'] / 'returns'
        target.mkdir(parents=True)
        (target / 'return-index.bin').write_bytes(b'OTHER_DATA')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.paths['STATE'].exists())
        self.assertEqual((old / 'return-index.bin').read_bytes(), b'RELEASE_DATA')
        self.assertEqual((target / 'return-index.bin').read_bytes(), b'OTHER_DATA')

    def test_private_prepared_files_of_another_uid_are_rejected_before_mutations(self):
        for parent in (self.release / '.cache/returns', self.paths['CACHE'] / 'returns'):
            with self.subTest(parent=parent):
                parent.mkdir(parents=True, exist_ok=True)
                binary = parent / 'return-index.bin'
                binary.write_bytes(b'PRIVATE_PREPARED_DATA')
                binary.chmod(0o600)
                try:
                    for apply in (False, True):
                        with self.assertRaisesRegex(PermissionError, 'Prepared data.*UID'):
                            MODULE.prepare_storage(self.release, os.getuid() + 1, os.getgid(), apply=apply)
                        self.assertFalse(self.paths['STATE'].exists())
                        self.assertFalse(self.paths['JOURNAL'].exists())
                        self.assertFalse((self.release / '.cache/lifetime').exists())
                        self.assertEqual(binary.read_bytes(), b'PRIVATE_PREPARED_DATA')
                        self.assertEqual(binary.stat().st_uid, os.getuid())
                        self.assertEqual(binary.stat().st_mode & 0o777, 0o600)
                finally:
                    binary.unlink()

    def test_unreadable_prepared_file_is_rejected_even_when_owner_matches(self):
        parent = self.release / '.cache/lifetime'
        parent.mkdir(parents=True)
        binary = parent / 'lifetime-1801-2400.f64le'
        binary.write_bytes(b'PREPARED_DATA')
        binary.chmod(0o200)
        with self.assertRaisesRegex(PermissionError, 'Prepared data.*readable'):
            self.prepare()
        self.assertFalse(self.paths['STATE'].exists())
        self.assertFalse((self.release / '.cache/returns').exists())
        self.assertEqual(binary.stat().st_mode & 0o777, 0o200)

    def test_a_foreign_link_is_rejected_and_never_retargeted(self):
        (self.release / '.cache').mkdir()
        foreign = self.base / 'foreign'
        foreign.mkdir()
        link = self.release / '.cache/lifetime'
        link.symlink_to(foreign, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(link.resolve(), foreign)
        self.assertFalse(self.paths['STATE'].exists())


if __name__ == '__main__':
    unittest.main()
