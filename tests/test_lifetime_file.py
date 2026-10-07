"""Full lifetime preparation preserves scalar values and publishes complete files."""
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import hashlib
import json
import shutil
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.python import astronomy as astro
from server.python import lifetime_file as lifetime


class LifetimeFileTests(unittest.TestCase):
    def test_shared_format_matches_full_moment_contract(self):
        planets, step, version, format_text = lifetime.lifetime_format()
        self.assertEqual(planets, [planet for planet, _ in astro.PLANET_BODIES])
        self.assertEqual(step, 600)
        self.assertEqual(version, '3')
        self.assertIn('sample-major', format_text)
        self.assertEqual(len(astro.MOMENT_FIELDS), 24)
        self.assertEqual(astro.MOMENT_FIELDS[-2:], ('exactDesignUnixSeconds', 'designArcResidualDegrees'))

    def test_rows_match_scalar_on_boundaries_and_preserve_pre_epoch_design_seconds(self):
        for start in ('1801-01-01T00:00:00+00:00', '2024-02-28T00:00:00+00:00', '2399-12-30T00:00:00+00:00'):
            offset, payload = lifetime.calculate_chunk(start, 0, 288, 600)
            self.assertEqual(offset, 0)
            self.assertEqual(len(payload), 288 * 192)
            for index in (0, 143, 144, 287):
                moment = dt.datetime.fromisoformat(start) + dt.timedelta(seconds=index * 600)
                jd = astro.julian_tt(moment)
                design_jd, residual = astro.design_time(jd)
                expected = [astro.longitude(side, body) for side in (jd, design_jd) for _, body in astro.PLANET_BODIES]
                expected += [int(astro.tt_to_datetime(design_jd).replace(microsecond=0).timestamp()), residual]
                self.assertEqual(payload[index*192:(index+1)*192], struct.pack('<24d', *expected))
                if start.startswith('1801'):
                    self.assertEqual(astro.tt_to_datetime(design_jd).year, 1800)
                    self.assertLess(expected[astro.DESIGN_UNIX_SECONDS_COLUMN], 0)

    def test_serial_parallel_and_chunk_boundaries_produce_identical_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            serial, parallel = [Path(directory) / (name + '.f64le') for name in ('serial', 'parallel')]
            one = lifetime.generate_lifetime_file(serial, '2024-02-28', '2024-03-02', workers=1)
            with mock.patch.object(lifetime, 'CHUNK_DAYS', 1):
                two = lifetime.generate_lifetime_file(parallel, '2024-02-28', '2024-03-02', workers=2)
            self.assertEqual(serial.read_bytes(), parallel.read_bytes())
            self.assertEqual(one['sha256'], two['sha256'])
            self.assertEqual(one['bytes'], 432 * 192)
            self.assertEqual(one['columns'], list(astro.MOMENT_FIELDS))
            self.assertEqual(one['provenance'], dict(version='1', calculationFingerprint=lifetime.calculation_fingerprint()))
            self.assertEqual(hashlib.sha256(serial.read_bytes()).hexdigest(), one['sha256'])
            self.assertEqual(json.loads(serial.with_suffix('.metadata.json').read_text()), one)
            for boundary, index in zip(one['boundaryCheck'], (0, 431)):
                self.assertEqual(struct.pack('<24d', *boundary['values']), serial.read_bytes()[index*192:(index+1)*192])

    def test_existing_data_or_metadata_is_never_overwritten(self):
        for suffix in ('.f64le', '.metadata.json'):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as directory:
                file = Path(directory) / 'lifetime.f64le'
                existing = file.with_suffix(suffix)
                existing.write_bytes(b'preserve')
                with self.assertRaises(FileExistsError):
                    lifetime.generate_lifetime_file(file, '2024-01-01', '2024-01-02', workers=1)
                self.assertEqual(existing.read_bytes(), b'preserve')

    def test_failed_calculation_leaves_no_final_or_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'lifetime.f64le'
            with mock.patch.object(lifetime, 'calculate_chunk', side_effect=RuntimeError('ephemeris unavailable')):
                with self.assertRaises(RuntimeError):
                    lifetime.generate_lifetime_file(file, '2024-01-01', '2024-01-02', workers=1)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_publication_race_cannot_clobber_an_existing_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary, destination = Path(directory) / 'temporary', Path(directory) / 'final'
            temporary.write_bytes(b'new')
            destination.write_bytes(b'existing')
            with self.assertRaises(FileExistsError):
                lifetime.publish_new(temporary, destination)
            self.assertEqual(destination.read_bytes(), b'existing')
            self.assertEqual(temporary.read_bytes(), b'new')

    def test_concurrent_generators_publish_one_complete_matching_pair(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'lifetime.f64le'
            def prepare(start, end):
                return subprocess.run([sys.executable, '-m', 'server.python.lifetime_file', '--file', str(file),
                                       '--start', start, '--end', end, '--workers', '1'],
                                      cwd=lifetime.ROOT, capture_output=True, text=True)
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(prepare, '2024-02-28', '2024-02-29')
                second = pool.submit(prepare, '2024-02-29', '2024-03-01')
                results = [first.result(), second.result()]
            self.assertEqual(sorted(result.returncode for result in results), [0, 1])
            metadata = json.loads(file.with_suffix('.metadata.json').read_text())
            self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(), metadata['sha256'])
            self.assertEqual(file.stat().st_size, metadata['bytes'])
            self.assertIn(metadata['startUtc'], ('2024-02-28T00:00:00Z', '2024-02-29T00:00:00Z'))
            self.assertEqual(file.read_bytes()[:192], struct.pack('<24d', *metadata['boundaryCheck'][0]['values']))
            self.assertEqual(set(item.name for item in Path(directory).iterdir()), {'lifetime.f64le', 'lifetime.metadata.json'})

    def test_changed_inputs_during_generation_never_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'lifetime.f64le'
            with mock.patch.object(lifetime, 'calculation_fingerprint', side_effect=['a'*64, 'b'*64]):
                with self.assertRaisesRegex(ValueError, 'inputs changed'):
                    lifetime.generate_lifetime_file(file, '2024-01-01', '2024-01-02', workers=1)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_fingerprint_tracks_optional_ephemeris_and_shared_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('server/python', 'shared', 'data/ephe'):
                shutil.copytree(lifetime.ROOT / name, root / name)
            shutil.copyfile(lifetime.ROOT / 'requirements.txt', root / 'requirements.txt')
            with mock.patch.object(lifetime, 'ROOT', root):
                original = lifetime.calculation_fingerprint()
                optional = root / 'data/ephe/seleapsec.txt'
                before = original
                for payload in (b'', b'20261231\n', b'20271231\n'):
                    optional.write_bytes(payload)
                    changed = lifetime.calculation_fingerprint()
                    self.assertNotEqual(changed, before)
                    before = changed
                optional.unlink()
                self.assertEqual(lifetime.calculation_fingerprint(), original)
                contract = root / 'shared/day-packets/moment-columns.js'
                contract.write_bytes(contract.read_bytes() + b'\n')
                self.assertNotEqual(lifetime.calculation_fingerprint(), original)

    def test_only_supported_exact_calendar_intervals_are_accepted(self):
        for start, end in (('1800-12-31', '1801-01-02'), ('2399-12-31', '2400-01-02'),
                           ('2024-01-01', '2024-01-01'), ('2024-1-01', '2024-01-02'),
                           ('2024-02-30', '2024-03-01')):
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                lifetime.interval(start, end)
        first, last = lifetime.interval('1801-01-01', '2400-01-01')
        self.assertEqual((last-first).days * 144, 31_504_320)


if __name__ == '__main__':
    unittest.main()
