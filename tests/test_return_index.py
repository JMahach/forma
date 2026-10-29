"""Prepared trajectories must preserve exact roots and reject malformed/corrupt files."""
import datetime as dt
import importlib
import hashlib
import json
import os
import math
import pathlib
import tempfile
import unittest
from unittest.mock import patch
from server.python import cycles, astronomy as astro

try:
    engine = importlib.import_module('server.python.return_index')
except ModuleNotFoundError:
    engine = None

class TrajectoryTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(engine, 'prepared return engine is missing')

    def test_station_exactly_on_grid_is_a_boundary_and_single_tangent(self):
        sample = lambda t: ((360*(2*t-t*t)) % 360, 720*(1-t))
        curve = engine.Trajectory.build(sample, 0, 2, .5)
        result = curve.search(sample, 0, 2)
        self.assertEqual(len(result), 1)
        self.assertAlmostEqual(result[0]['jd'], 1)
        self.assertEqual(result[0]['direction'], 'stationary')

    def test_station_angle_tolerance_does_not_merge_two_bracketed_passes(self):
        amplitude, duration = 360+1e-9, 100
        sample = lambda t: ((amplitude*(2*t/duration-(t/duration)**2)) % 360, 2*amplitude/duration*(1-t/duration))
        curve = engine.Trajectory.build(sample, 0, 200, .3)
        result = curve.search(sample, 0, 200)
        self.assertEqual([r['direction'] for r in result], ['direct', 'retrograde'])
        self.assertAlmostEqual((result[1]['jd']-result[0]['jd'])*86400, 28.8, delta=.01)

    def test_final_root_uses_exact_origin_not_large_accumulated_phase(self):
        origin = .123456789
        sample = lambda t: ((origin+.001*t) % 360, .001)
        times = [float(t) for t in range(0, 400001, 10000)]
        phases = [360_000_000+origin+.001*t for t in times]
        curve = engine.Trajectory(times, phases, [0, len(times)-1])
        result = curve.search(sample, 0, 400000)
        self.assertEqual(len(result), 1)
        self.assertAlmostEqual(result[0]['jd'], 360000, delta=1e-8)

    def test_opposition_parameter_does_not_mutate_shared_trajectory(self):
        sample = lambda t: ((350+50*t) % 360, 50)
        curve = engine.Trajectory.build(sample, 0, 12, 1)
        returns = curve.search(sample, 0, 12)
        opposition = curve.search(sample, 0, 12, offset=180)
        self.assertEqual([round(r['jd'], 8) for r in opposition], [3.6, 10.8])
        self.assertEqual(curve.search(sample, 0, 12), returns)

    def test_small_lunar_segment_jump_preserves_two_returns_seconds_apart(self):
        start = astro.julian_tt(cycles.parse_utc('2000-05-14T11:47:59.390189Z'))
        end = astro.julian_tt(cycles.parse_utc('2018-12-26T00:00:00Z'))
        curve = engine.prepare_trajectory('north_node', start, end)
        roots = curve.search(lambda jd: engine.position(jd, 'north_node'), start, end, direction=-1)
        stamps = [cycles.exact_iso(astro.tt_to_datetime(root['jd'])) for root in roots]
        self.assertEqual([root['direction'] for root in roots], ['retrograde', 'direct', 'direct'])
        expected = ['2018-12-25T22:01:01.050068Z', '2018-12-25T22:01:03.607930Z']
        for actual, wanted in zip(stamps[-2:], expected):
            self.assertLess(abs((cycles.parse_utc(actual)-cycles.parse_utc(wanted)).total_seconds()), .002)

    def test_segment_sides_are_adjacent_floats_and_include_light_time(self):
        for utc in ('1899-11-11T06:45:21.981052Z', '2018-12-25T22:01:02.324412Z'):
            with self.subTest(utc=utc):
                expected = astro.julian_tt(cycles.parse_utc(utc))
                cuts = engine.lunar_segment_cuts(expected-.1, expected+.1)
                self.assertEqual(len(cuts), 1)
                left, right = cuts[0]
                self.assertEqual(math.nextafter(left, right), right)
                self.assertEqual(engine.lunar_segment_cuts(left, expected+.1), cuts)
                self.assertEqual(engine.lunar_segment_cuts(expected-.1, right), cuts)
                self.assertLess(abs(right-expected)*86400, .001)
                before = engine.position(left, 'north_node')[0]
                after = engine.position(right, 'north_node')[0]
                self.assertGreater(abs(engine.angle_delta(after, before)), 1e-7)

    def test_query_does_not_return_boundary_root_beyond_requested_end(self):
        sample = lambda t: ((350+50*t) % 360, 50)
        curve = engine.Trajectory.build(sample, 0, 12, 1)
        self.assertEqual(curve.search(sample, 0, 7), [])
        self.assertAlmostEqual(curve.search(sample, 0, 7.2)[0]['jd'], 7.2)

class FileTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(engine, 'prepared return engine is missing')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = pathlib.Path(self.temp.name)/'returns.bin'
        self.start = astro.julian_tt(cycles.parse_utc('2000-01-01T00:00:00Z'))
        self.end = self.start+40

    def build(self):
        return engine.prepare_index(self.path, start=self.start, end=self.end, bodies=('north_node',))

    def test_prepared_index_has_no_calculation_provenance_and_reuses_ready_numbers(self):
        header = self.build()
        self.assertNotIn('provenance', header)
        before = self.path.read_bytes()
        with patch.object(engine, 'prepare_trajectory', side_effect=AssertionError('No recalculation')):
            self.assertTrue(self.build()['reused'])
            with engine.load_index(self.path, full=True) as index:
                self.assertIsNotNone(index.trajectory('north_node'))
        self.assertEqual(self.path.read_bytes(), before)

    def historical(self):
        self.build()
        raw = self.path.read_bytes()
        _, size, _ = engine.PREFIX.unpack_from(raw)
        header = json.loads(raw[engine.PREFIX.size:engine.PREFIX.size+size])
        payload = raw[engine.PREFIX.size+size:]
        header['provenance'] = 'a'*64
        encoded = json.dumps(header, separators=(',', ':')).encode()
        self.path.write_bytes(engine.PREFIX.pack(engine.MAGIC, len(encoded), hashlib.sha256(encoded).digest())+encoded+payload)
        return payload

    def test_explicit_transition_preserves_all_trajectory_bytes_without_calculation_and_repeats_without_payload_read(self):
        payload = self.historical()
        self.path.chmod(0o640)
        with patch.object(engine, 'prepare_trajectory', side_effect=AssertionError('No recalculation')):
            self.assertTrue(engine.migrate_index(self.path))
        raw = self.path.read_bytes()
        _, size, checksum = engine.PREFIX.unpack_from(raw)
        header = raw[engine.PREFIX.size:engine.PREFIX.size+size]
        self.assertNotIn('provenance', json.loads(header))
        self.assertEqual(hashlib.sha256(header).digest(), checksum)
        self.assertEqual(raw[engine.PREFIX.size+size:], payload)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o640)
        before = self.path.stat().st_mtime_ns
        with patch.object(engine, 'load_index', side_effect=AssertionError('No repeat payload scan')):
            self.assertFalse(engine.migrate_index(self.path))
        self.assertEqual(self.path.stat().st_mtime_ns, before)
        with engine.load_index(self.path, full=True) as index:
            self.assertIsNotNone(index.trajectory('north_node'))

    def test_interrupted_transition_leaves_a_complete_old_or_new_file_and_no_temporary_copy(self):
        for boundary in ('file_sync', 'before_replace', 'after_replace', 'directory_sync'):
            with self.subTest(boundary=boundary):
                payload = self.historical()
                original = self.path.read_bytes()
                replace, sync = engine.os.replace, engine.os.fsync
                syncs = 0
                def interrupted_sync(fd):
                    nonlocal syncs
                    syncs += 1
                    sync(fd)
                    if boundary == 'file_sync' and syncs == 1 or boundary == 'directory_sync' and syncs == 2:
                        raise OSError('interrupted')
                def interrupted_replace(source, target):
                    if boundary == 'before_replace':
                        raise OSError('interrupted')
                    replace(source, target)
                    if boundary == 'after_replace':
                        raise OSError('interrupted')
                with patch.object(engine.os, 'replace', side_effect=interrupted_replace), patch.object(engine.os, 'fsync', side_effect=interrupted_sync):
                    with self.assertRaisesRegex(OSError, 'interrupted'):
                        engine.migrate_index(self.path)
                with engine.load_index(self.path, full=True) as index:
                    self.assertEqual(bytes(index.data[index.base:]), payload)
                if boundary in ('file_sync', 'before_replace'):
                    self.assertEqual(self.path.read_bytes(), original)
                engine.migrate_index(self.path)
                self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_transition_refuses_corrupt_or_concurrently_changed_sources(self):
        self.historical()
        original = self.path.read_bytes()
        damaged = bytearray(original); damaged[-1] ^= 1; self.path.write_bytes(damaged)
        with self.assertRaises(engine.InvalidIndex):
            engine.migrate_index(self.path)
        self.assertEqual(self.path.read_bytes(), damaged)
        self.path.write_bytes(original)
        sync = engine.os.fsync
        def change_source(fd):
            sync(fd)
            self.path.write_bytes(damaged)
        with patch.object(engine.os, 'fsync', side_effect=change_source):
            with self.assertRaisesRegex(engine.InvalidIndex, 'changed'):
                engine.migrate_index(self.path)
        self.assertEqual(self.path.read_bytes(), damaged)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_atomic_build_idempotent_load_and_read_only_arrays(self):
        self.build()
        before = self.path.stat().st_mtime_ns
        self.build()
        self.assertEqual(self.path.stat().st_mtime_ns, before)
        with engine.load_index(self.path) as index:
            curve = index.trajectory('north_node')
            with self.assertRaises(TypeError):
                curve.times[0] = self.start+1
            self.assertEqual(curve.search(lambda jd:engine.position(jd,'north_node'),self.start,self.end), [])

    def test_prepared_gap_preserves_both_valid_roots_and_excludes_the_jump(self):
        start=astro.julian_tt(cycles.parse_utc('1881-03-31T01:18:00Z'))
        end=astro.julian_tt(cycles.parse_utc('1901-03-31T01:18:00Z'))
        engine.prepare_index(self.path,start=start,end=end,bodies=('north_node',))
        with engine.load_index(self.path,full=True) as prepared:
            self.assertGreater(len(prepared.trajectory('north_node').gaps),0)
        roots=engine.find_crossings('north_node',start,end,index_path=self.path)
        dates=[cycles.exact_iso(astro.tt_to_datetime(root['jd'])) for root in roots]
        self.assertEqual(len(roots),4)
        self.assertEqual([date[:16] for date in dates[-2:]],['1899-11-11T06:37','1899-11-11T06:46'])
        self.assertEqual([root['direction'] for root in roots[-2:]],['retrograde','retrograde'])

    def test_lunar_header_must_match_the_actual_supported_file(self):
        engine.position(self.start, 'north_node')
        source = pathlib.Path(astro.swe.get_current_file_data(1)[0])
        low, high, step = engine.lunar_file_segments(source)
        self.assertLess(low, self.start)
        self.assertGreater(high, self.end)
        self.assertTrue(27.5 < step < 27.6)
        damaged = bytearray(source.read_bytes())
        damaged[0] = ord('X')
        self.path.write_bytes(damaged)
        with self.assertRaises(ValueError):
            engine.lunar_file_segments(self.path)

    def test_changed_bytes_are_rejected(self):
        self.build()
        data=bytearray(self.path.read_bytes()); data[-1]^=1; self.path.write_bytes(data)
        with self.assertRaises(engine.InvalidIndex):
            engine.load_index(self.path)

    def test_failed_rebuild_keeps_previous_file(self):
        self.build(); previous=self.path.read_bytes()
        with patch.object(engine, 'prepare_trajectory', side_effect=RuntimeError('interrupted')):
            with self.assertRaises(RuntimeError):
                engine.prepare_index(self.path,start=self.start,end=self.end+1,bodies=('north_node',))
        self.assertEqual(self.path.read_bytes(),previous)
        self.assertEqual(list(self.path.parent.iterdir()),[self.path])

    def test_missing_file_falls_back_without_creating_any_files(self):
        roots=engine.find_crossings('north_node',self.start,self.end,index_path=self.path)
        self.assertEqual(roots,[])
        self.assertEqual(list(self.path.parent.iterdir()),[])

class NativeTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(engine, 'prepared return engine is missing')

    def test_native_solar_crossing_keeps_reference_and_strict_flags(self):
        start=astro.julian_tt(cycles.parse_utc('2000-01-01T00:00:00Z'))
        roots=engine.native_crossings('sun',start,start+370)
        self.assertEqual(len(roots),1)
        target=engine.position(start,'sun')[0]
        actual=engine.position(roots[0]['jd'],'sun')[0]
        self.assertLess(abs(engine.angle_delta(actual,target)),1e-7)
        with patch.object(astro.swe,'calc',return_value=((1,0,1,0,0,0),astro.swe.FLG_MOSEPH)):
            with self.assertRaises(cycles.ChartError):
                engine.native_crossings('sun',start,start+370)

    def test_native_tail_stays_inside_supported_range(self):
        start=astro.julian_tt(cycles.parse_utc('2399-01-01T00:00:00Z'))
        end=astro.julian_tt(cycles.parse_utc('2399-12-31T23:59:59Z'))
        real=engine.position
        def checked(jd,body):
            self.assertGreaterEqual(jd,start);self.assertLessEqual(jd,end)
            return real(jd,body)
        with patch.object(engine,'position',side_effect=checked):
            roots=engine.native_crossings('sun',start,end)
        self.assertTrue(all(start<r['jd']<=end for r in roots))

if __name__ == '__main__':
    unittest.main()
