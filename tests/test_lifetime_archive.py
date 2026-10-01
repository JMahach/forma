"""Archive preparation preserves production values and publishes complete files."""
import datetime as dt
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.python import astronomy as astro
from server.python import lifetime_archive as archive
from server.python.transit_day import PLANETS as TRANSIT_PLANETS


class LifetimeArchiveTests(unittest.TestCase):
    def test_shared_format_matches_full_transit_planet_contract(self):
        planets, step, version, format_text = archive.archive_format()
        self.assertEqual(planets, list(TRANSIT_PLANETS))
        self.assertEqual(step, 600)
        self.assertEqual(version, '2')
        self.assertIn('planet-major', format_text)

    def test_chunk_offsets_and_calendar_boundaries_match_full_production_call_order(self):
        planets, step, _, _ = archive.archive_format()
        for start in ('1801-01-01T00:00:00+00:00', '2024-02-28T00:00:00+00:00', '2399-12-30T00:00:00+00:00'):
            offset, columns = archive.calculate_chunk(start, 140, 148, planets, step)
            self.assertEqual(offset, 140)
            for local in (0, 3, 4, 5, 147):
                moment = dt.datetime.fromisoformat(start) + dt.timedelta(seconds=(offset + local) * step)
                values = astro.longitudes(astro.julian_tt(moment))
                for planet, column in zip(planets, columns):
                    self.assertEqual(column[local*8:(local+1)*8], struct.pack('<d', values[planet]))

    def test_serial_and_parallel_archives_have_identical_bytes_and_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            one, two = Path(directory) / 'one.f64le', Path(directory) / 'two.f64le'
            serial = archive.generate_archive(one, '2024-02-29', '2024-03-01', workers=1)
            parallel = archive.generate_archive(two, '2024-02-29', '2024-03-01', workers=2)
            self.assertEqual(one.read_bytes(), two.read_bytes())
            self.assertEqual(serial['sha256'], parallel['sha256'])
            self.assertEqual(serial['sha256'], hashlib.sha256(one.read_bytes()).hexdigest())
            self.assertEqual(serial['bytes'], 144 * len(TRANSIT_PLANETS) * 8)
            self.assertEqual(serial['sampleCount'], 144)
            self.assertEqual(serial['stepSeconds'], 600)
            self.assertEqual(serial, json.loads(one.with_suffix('.metadata.json').read_text()))
            data = one.read_bytes()
            planets = serial['columns']
            start = dt.datetime(2024, 2, 29, tzinfo=archive.UTC)
            for index in (0, 71, 143):
                values = astro.longitudes(astro.julian_tt(start + dt.timedelta(minutes=index * 10)))
                for column, planet in enumerate(planets):
                    position = (column * serial['sampleCount'] + index) * 8
                    self.assertEqual(data[position:position+8], struct.pack('<d', values[planet]))
            self.assertEqual(set(p.name for p in Path(directory).iterdir()),
                             {'one.f64le', 'one.metadata.json', 'two.f64le', 'two.metadata.json'})

    def test_reused_version_one_subset_is_exact_and_only_missing_planets_are_computed(self):
        planets, step, version, format_text = archive.archive_format()
        # Reversed subset order also exercises remapping to canonical offsets.
        old_planets = ['pluto', 'neptune', 'uranus', 'saturn', 'jupiter', 'north_node']
        with tempfile.TemporaryDirectory() as directory:
            source, reused, fresh = [Path(directory) / (name + '.f64le') for name in ('old', 'reused', 'fresh')]
            with mock.patch.object(archive, 'archive_format', return_value=(old_planets, step, '1', format_text)):
                old = archive.generate_archive(source, '2024-02-28', '2024-03-01', workers=1)
            original = source.read_bytes()
            with mock.patch.object(archive, 'calculate_chunk', wraps=archive.calculate_chunk) as calculate:
                result = archive.generate_archive(reused, '2024-02-28', '2024-03-01', workers=1, reuse_file=source)
            missing = ['sun', 'moon', 'mercury', 'venus', 'mars']
            self.assertTrue(calculate.call_count)
            self.assertTrue(all(call.args[3] == missing for call in calculate.call_args_list))
            archive.generate_archive(fresh, '2024-02-28', '2024-03-01', workers=1)
            self.assertEqual(reused.read_bytes(), fresh.read_bytes())
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(result['version'], version)
            self.assertEqual(result['columns'], planets)
            self.assertEqual(result['computedColumns'], missing)
            self.assertEqual(result['reusedArchive'], dict(version='1', columns=old_planets, sha256=old['sha256']))
            # A complete compatible archive requires no ephemeris chunk calls.
            copied = Path(directory) / 'copied.f64le'
            with mock.patch.object(archive, 'calculate_chunk', side_effect=AssertionError('Nothing missing')):
                archive.generate_archive(copied, '2024-02-28', '2024-03-01', workers=1, reuse_file=fresh)
            self.assertEqual(copied.read_bytes(), fresh.read_bytes())

    def test_incompatible_or_corrupt_reuse_is_rejected_before_missing_calculation(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'source.f64le', Path(directory) / 'output.f64le'
            metadata = archive.generate_archive(source, '2024-02-29', '2024-03-01', workers=1)
            metadata_file = source.with_suffix('.metadata.json')
            for changed in ({'version': '0'}, {'format': 'Float32'}, {'stepSeconds': 60},
                            {'startUtc': '2024-02-28T00:00:00Z'}, {'sampleCount': 1},
                            {'flags': 2}, {'engine': 'Swiss Ephemeris 0.0'}, {'sha256': 'a'*64},
                            {'columns': ['unknown']}, {'columns': ['sun', 'sun']}):
                metadata_file.write_text(json.dumps(dict(metadata, **changed)))
                with self.subTest(changed=changed), mock.patch.object(archive, 'calculate_chunk', side_effect=AssertionError('Invalid reuse')):
                    with self.assertRaises(ValueError):
                        archive.generate_archive(output, '2024-02-29', '2024-03-01', workers=1, reuse_file=source)
                self.assertFalse(output.exists())
                self.assertFalse(output.with_suffix('.metadata.json').exists())
            metadata_file.write_text(json.dumps(metadata))
            with source.open('r+b') as stream:
                stream.write(struct.pack('<d', 123.456))
            with mock.patch.object(archive, 'calculate_chunk', side_effect=AssertionError('Corrupt reuse')):
                with self.assertRaisesRegex(ValueError, 'SHA256'):
                    archive.generate_archive(output, '2024-02-29', '2024-03-01', workers=1, reuse_file=source)
            self.assertEqual(set(p.name for p in Path(directory).iterdir()), {'source.f64le', 'source.metadata.json'})

    def test_existing_archive_or_metadata_is_never_overwritten(self):
        for suffix in ('.f64le', '.metadata.json'):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as directory:
                file = Path(directory) / 'archive.f64le'
                existing = file.with_suffix(suffix)
                existing.write_bytes(b'preserve')
                with self.assertRaises(FileExistsError):
                    archive.generate_archive(file, '2024-01-01', '2024-01-02', workers=1)
                self.assertEqual(existing.read_bytes(), b'preserve')

    def test_failed_calculation_leaves_no_final_or_temporary_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'archive.f64le'
            with mock.patch.object(archive, 'calculate_chunk', side_effect=RuntimeError('ephemeris unavailable')):
                with self.assertRaises(RuntimeError):
                    archive.generate_archive(file, '2024-01-01', '2024-01-02', workers=1)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_publication_race_cannot_clobber_an_existing_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary, destination = Path(directory) / 'temporary', Path(directory) / 'final'
            temporary.write_bytes(b'new')
            destination.write_bytes(b'existing')
            with self.assertRaises(FileExistsError):
                archive.publish_new(temporary, destination)
            self.assertEqual(destination.read_bytes(), b'existing')
            self.assertEqual(temporary.read_bytes(), b'new')

    def test_only_supported_exact_calendar_intervals_are_accepted(self):
        for start, end in (('1800-12-31', '1801-01-02'), ('2399-12-31', '2400-01-02'),
                           ('2024-01-01', '2024-01-01'), ('2024-1-01', '2024-01-02'),
                           ('2024-02-30', '2024-03-01')):
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                archive.interval(start, end)
        first, last = archive.interval('1801-01-01', '2400-01-01')
        self.assertEqual((last-first).days * 144, 31_504_320)


if __name__ == '__main__':
    unittest.main()
