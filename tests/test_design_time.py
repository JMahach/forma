"""Exact canonical-prefix reuse, with a frozen independent search oracle."""
import array
import datetime as dt
import math
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from server.python import astronomy as astro
from server.python import chart_day, transit_day
from server.python.errors import ChartError


def reference_search(birth_jd, trace=None):
    birth_sun = astro.longitude(birth_jd, astro.swe.SUN)
    low, high = birth_jd - 100, birth_jd - 75
    for index in range(48):
        mid = (low + high) / 2
        if (birth_sun - astro.longitude(mid, astro.swe.SUN)) % 360 > 88:
            low = mid
        else:
            high = mid
        if trace is not None and 27 <= index <= 33:
            trace[index + 1] = (low, high)
    result = (low + high) / 2
    residual = abs((birth_sun - astro.longitude(result, astro.swe.SUN)) % 360 - 88)
    if residual > 1e-7:
        raise ChartError('design_search_failed', 'Не удалось точно определить момент дизайна.')
    return result, residual


def bits(values):
    return array.array('d', values).tobytes()


class DesignTimeReuseTests(unittest.TestCase):
    def test_exact_endpoint_ties_plateaus_bad_and_nonfinite_guesses(self):
        birth = 2451545.0
        low, high = birth - 100, birth - 75
        roots = []
        for depth in range(1, 35):
            mid = (low + high) / 2
            if depth in (1, 8, 16, 24, 28, 30, 32, 34):
                roots.extend((math.nextafter(mid, -math.inf), mid, math.nextafter(mid, math.inf)))
            if depth % 2:
                low = mid
            else:
                high = mid
        accepted = parent_accepted = zero_lower = zero_upper = 0
        for root in roots:
            for plateau in (False, True):
                def solar(jd, _body):
                    if jd == birth:
                        return 100.0
                    delta = jd - root
                    if plateau:
                        step = math.ulp(root) * 4
                        delta = math.floor(delta / step) * step
                    return (12.0 + delta) % 360
                with mock.patch.object(astro, 'longitude', side_effect=solar):
                    canonical = {}
                    expected = reference_search(birth, canonical)
                width = 25 / 2**34
                for hint in (root, root - width, root + width, birth - 1000, birth + 1000, math.nan, math.inf, -math.inf):
                    with self.subTest(root=root, plateau=plateau, hint=hint):
                        with mock.patch.object(astro, 'longitude', side_effect=solar) as calls:
                            actual = astro.design_time(birth, hint=hint)
                        self.assertEqual(bits(actual), bits(expected))
                        self.assertEqual(calls.call_args.args, (expected[0], astro.swe.SUN))
                        if not math.isfinite(hint):
                            continue
                        low, high = birth - 100, birth - 75
                        nodes = []
                        for depth in range(1, 35):
                            mid = (low + high) / 2
                            if hint >= mid:
                                low = mid
                            else:
                                high = mid
                            if depth >= 28:
                                nodes.append((depth, low, high))
                        found = False
                        for depth, low, high in reversed(nodes):
                            lower = (100 - solar(low, 0)) % 360
                            upper = (100 - solar(high, 0)) % 360
                            if lower == 88:
                                zero_lower += 1
                            if lower > 88 and upper <= 88:
                                found = True
                                accepted += 1
                                parent_accepted += depth < 34
                                self.assertEqual(bits((low, high)), bits(canonical[depth]))
                                self.assertLess(calls.call_count, 30)
                                if upper == 88:
                                    zero_upper += 1
                                break
                        if not found:
                            self.assertGreater(calls.call_count, 30)
        self.assertGreater(accepted, 0)
        self.assertGreater(parent_accepted, 0)
        self.assertGreater(zero_lower, 0)
        self.assertGreater(zero_upper, 0)

    def test_optional_probe_failure_falls_back_but_original_errors_survive(self):
        birth = astro.julian_tt(dt.datetime(2026, 9, 30, tzinfo=astro.UTC))
        expected = reference_search(birth)
        probe, high = birth - 100, birth - 75
        for _ in range(34):
            probe = (probe + high) / 2
        original = astro.longitude
        def fail_probe(jd, body):
            if jd == probe:
                raise ChartError('ephemeris_unavailable', 'optional probe')
            return original(jd, body)
        with mock.patch.object(astro, 'longitude', side_effect=fail_probe):
            self.assertEqual(bits(astro.design_time(birth, hint=birth + 1000)), bits(expected))
        for hint in (None, expected[0], birth + 1000):
            with mock.patch.object(astro, 'longitude', side_effect=ChartError('ephemeris_unavailable', 'required sample')):
                with self.assertRaises(ChartError) as failure:
                    astro.design_time(birth, hint=hint)
                self.assertEqual(failure.exception.payload['message'], 'required sample')
            with mock.patch.object(astro, 'longitude', return_value=0.0):
                with self.assertRaises(ChartError) as failure:
                    astro.design_time(birth, hint=hint)
                self.assertEqual(failure.exception.payload['error'], 'design_search_failed')

    def test_real_sequences_across_seasons_bounds_jumps_and_repeated_inputs(self):
        baseline_calls = candidate_calls = 0
        for year, month, day in ((1801, 1, 1), (1900, 3, 1), (2000, 2, 29), (2026, 6, 21), (2399, 12, 31)):
            start = dt.datetime(year, month, day, tzinfo=astro.UTC)
            moments = [astro.julian_tt(start + dt.timedelta(minutes=minute))
                       for minute in (*range(24), 1439, 1439, 720, 721, 722)]
            search = astro.DesignTimeSearch()
            for jd in moments:
                with mock.patch.object(astro, 'longitude', wraps=astro.longitude) as calls:
                    expected = astro.design_time(jd)
                    baseline_calls += calls.call_count
                with mock.patch.object(astro, 'longitude', wraps=astro.longitude) as calls:
                    actual = search(jd)
                    candidate_calls += calls.call_count
                self.assertEqual(bits(actual), bits(expected))
        self.assertLess(candidate_calls, baseline_calls * .6)

    def test_state_is_local_and_advances_only_after_success(self):
        first, second = astro.DesignTimeSearch(), astro.DesignTimeSearch()
        birth = 2451545.0
        first(birth)
        previous = first.previous
        with mock.patch.object(astro, 'longitude', side_effect=ChartError('ephemeris_unavailable', 'failure')):
            with self.assertRaises(ChartError):
                first(birth + 1 / 1440)
        self.assertEqual(first.previous, previous)
        self.assertIsNone(first.older)
        self.assertIsNone(second.previous)
        with mock.patch.object(astro, 'design_time', wraps=astro.design_time) as calls:
            second(birth)
        self.assertIsNone(calls.call_args.kwargs['hint'])

    def test_design_seconds_floor_before_epoch_without_string_roundtrip(self):
        values = {planet: index + .125 for index, (planet, _) in enumerate(astro.PLANET_BODIES)}
        for moment in (dt.datetime(1800, 10, 5, 12, 34, 56, 999999, tzinfo=astro.UTC),
                       dt.datetime(1969, 12, 31, 23, 59, 59, 999999, tzinfo=astro.UTC),
                       dt.datetime(1970, 1, 1, 0, 0, 0, 999999, tzinfo=astro.UTC),
                       dt.datetime(2399, 9, 30, 23, 59, 59, 999999, tzinfo=astro.UTC)):
            expected = int(dt.datetime.fromisoformat(moment.isoformat(timespec='seconds')).timestamp())
            for calculate, args in ((chart_day.calculate_day, ('2026-09-30', 'UTC')),
                                    (transit_day.calculate_day, ('2026-09-30',))):
                with self.subTest(moment=moment, worker=calculate.__module__), \
                        mock.patch.object(astro, 'julian_tt', return_value=0), \
                        mock.patch.object(astro, 'design_time', return_value=(-88, 0.0)), \
                        mock.patch.object(astro, 'longitudes', return_value=values), \
                        mock.patch.object(astro, 'tt_to_datetime', return_value=moment), \
                        mock.patch.object(dt, 'datetime', wraps=dt.datetime) as dates:
                    day = calculate(*args)
                self.assertEqual(day['columns'][22], [expected] * 1440)
                self.assertEqual(dates.fromisoformat.call_count, 0)
        self.assertEqual(int(dt.datetime(1969, 12, 31, 23, 59, 59, tzinfo=astro.UTC).timestamp()), -1)

    def test_complete_days_retain_every_float_and_metadata(self):
        cases = [
            (chart_day.calculate_day, ('1801-01-01', 'UTC')),
            (chart_day.calculate_day, ('2399-12-31', 'UTC')),
            (chart_day.calculate_day, ('2024-03-10', 'America/New_York')),
            (chart_day.calculate_day, ('2024-11-03', 'America/New_York')),
            (chart_day.calculate_day, ('2026-10-04', 'Australia/Lord_Howe')),
            (chart_day.calculate_day, ('1900-01-01', 'Europe/Paris')),
            (chart_day.calculate_day, ('1892-07-04', 'Pacific/Apia')),
            (transit_day.calculate_day, ('1801-01-01',)),
            (transit_day.calculate_day, ('2024-02-29',)),
            (transit_day.calculate_day, ('2399-12-31',)),
        ]
        for calculate, args in cases:
            with self.subTest(calculate=calculate.__module__, args=args):
                expected_results, actual_results = [], []
                original = astro.design_time
                def record_reference(jd):
                    result = reference_search(jd)
                    expected_results.append(bits(result))
                    return result
                def record_actual(jd, **kwargs):
                    result = original(jd, **kwargs)
                    actual_results.append(bits(result))
                    return result
                with mock.patch.object(astro, 'DesignTimeSearch', return_value=record_reference):
                    expected = calculate(*args)
                with mock.patch.object(astro, 'design_time', side_effect=record_actual):
                    actual = calculate(*args)
                self.assertEqual(actual_results, expected_results)
                self.assertEqual(len(actual['columns']), 24)
                for old, new in zip(expected.pop('columns'), actual.pop('columns')):
                    self.assertEqual(bits(old), bits(new))
                self.assertEqual(actual, expected)


if __name__ == '__main__':
    unittest.main()
