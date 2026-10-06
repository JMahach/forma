"""Exact UTC restoration uses one scalar instant and the existing astronomy."""
import pathlib
import struct
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from server.python import calculator, astronomy as astro, civil_time as civil
from server.python.errors import ChartError


class ExactMomentTests(unittest.TestCase):
    def test_full_moment_matches_existing_natal_bits_without_day_generation(self):
        for utc in ('1801-01-01T12:31:00Z', '1900-03-01T12:31:00Z',
                    '2000-02-29T12:31:00Z', '2026-10-02T12:31:00Z', '2399-12-31T12:31:00Z'):
            with self.subTest(utc=utc):
                expected = calculator.calculate(dict(mode='natal', name='Parity', date=utc[:10], time=utc[11:16],
                    city=dict(id='utc', name='UTC', timezone='UTC')))['chart']
                with mock.patch.object(astro, 'sample_columns', side_effect=AssertionError('No day')):
                    actual = calculator.calculate(dict(mode='transit_moment', utc=utc))
                self.assertEqual(actual['utc'], utc)
                for side, values in (('personality', actual['longitudes']), ('design', actual['design']['longitudes'])):
                    expected_values = {value['planet']: value['longitude'] for value in expected['activations'][side]}
                    self.assertEqual([struct.pack('d', value) for value in values],
                                     [struct.pack('d', expected_values[name]) for name, _ in astro.PLANET_BODIES])
                self.assertEqual(actual['design']['designUtc'], expected['designUtc'])
                self.assertEqual(actual['design']['designArcResidualDegrees'], expected['designArcResidualDegrees'])

    def test_milliseconds_are_not_rounded_and_full_moment_searches_design_once(self):
        utc = '2026-10-02T12:31:23.456Z'
        with mock.patch.object(astro, 'design_time', wraps=astro.design_time) as design_time:
            actual = calculator.calculate(dict(mode='transit_moment', utc=utc))
            self.assertEqual(design_time.call_count, 1)
        self.assertEqual(actual['utc'], utc)
        self.assertEqual(actual['longitudes'], list(astro.longitudes(astro.julian_tt(civil.transit_utc(utc))).values()))

    def test_invalid_dates_fail_before_astronomy(self):
        with mock.patch.object(astro, 'longitudes', side_effect=AssertionError('Invalid UTC must not calculate')):
            for utc in ('1800-12-31T23:59:59Z', '2400-01-01T00:00:00Z', '2026-02-30T12:31:00Z', '2026-10-02'):
                with self.subTest(utc=utc), self.assertRaises(ChartError):
                    calculator.calculate(dict(mode='transit_moment', utc=utc))


if __name__ == '__main__':
    unittest.main()
