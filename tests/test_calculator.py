"""Offline calculator regression tests, using real Swiss Ephemeris files.

The two outside reference examples below are supplemental smoke checks. They
do not certify agreement with an independent Human Design reference corpus.
"""
import datetime as dt
import math
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from server.python import calculator as calc
from server.python import astronomy as astro
from server.python import civil_time as civil
from server.python.errors import ChartError


class HistoricalTimezoneTests(unittest.TestCase):
    def test_historical_moscow_offsets(self):
        for date, expected_utc, label in [
            ('1990-07-15', '1990-07-15T08:00:00Z', 'UTC+04:00'),
            ('2012-01-15', '2012-01-15T08:00:00Z', 'UTC+04:00'),
            ('2020-01-15', '2020-01-15T09:00:00Z', 'UTC+03:00'),
        ]:
            with self.subTest(date=date):
                moment, offset, fold = civil.local_to_utc(date, '12:00', 'Europe/Moscow')
                self.assertEqual(civil.iso(moment), expected_utc)
                self.assertEqual(offset, label)
                self.assertEqual(fold, 0)

    def test_spring_forward_gap_is_rejected(self):
        for fold in (None, 0, 1):
            with self.subTest(fold=fold):
                with self.assertRaises(ChartError) as error:
                    civil.local_to_utc('2024-03-10', '02:30', 'America/New_York', fold)
                self.assertEqual(error.exception.payload['error'], 'nonexistent_time')

    def test_fall_back_requires_choice_then_resolves_one_hour_apart(self):
        with self.assertRaises(ChartError) as error:
            civil.local_to_utc('2024-11-03', '01:30', 'America/New_York')
        self.assertEqual(error.exception.payload['error'], 'ambiguous_time')
        self.assertEqual(len(error.exception.payload['choices']), 2)
        first, first_offset, first_fold = civil.local_to_utc('2024-11-03', '01:30', 'America/New_York', 0)
        second, second_offset, second_fold = civil.local_to_utc('2024-11-03', '01:30', 'America/New_York', 1)
        self.assertEqual(civil.iso(first), '2024-11-03T05:30:00Z')
        self.assertEqual(civil.iso(second), '2024-11-03T06:30:00Z')
        self.assertEqual(second - first, dt.timedelta(hours=1))
        self.assertEqual((first_fold, second_fold), (0, 1))
        self.assertEqual((first_offset, second_offset), ('UTC−04:00', 'UTC−05:00'))

    def test_boolean_or_invalid_fold_does_not_silently_choose(self):
        for fold in (True, False, '0', '1', -1, 2):
            with self.subTest(fold=fold):
                with self.assertRaises(ChartError) as error:
                    civil.local_to_utc('2024-11-03', '01:30', 'America/New_York', fold)
                self.assertEqual(error.exception.payload['error'], 'ambiguous_time')

    def test_invalid_leap_dates_times_and_timezones(self):
        for date, time, timezone in [
            ('2023-02-29', '12:00', 'UTC'),
            ('1900-02-29', '12:00', 'UTC'),
            ('2024-02-30', '12:00', 'UTC'),
            ('2024-04-31', '12:00', 'UTC'),
            ('2024-01-01', '24:00', 'UTC'),
            ('2024-01-01', '12:60', 'UTC'),
            ('2024-01-01', '12:00', 'Invented/Zone'),
        ]:
            with self.subTest(date=date, time=time, timezone=timezone):
                with self.assertRaises(ChartError) as error:
                    civil.local_to_utc(date, time, timezone)
                self.assertEqual(error.exception.payload['error'], 'invalid_datetime')
        self.assertEqual(civil.iso(civil.local_to_utc('2000-02-29', '12:00', 'UTC')[0]), '2000-02-29T12:00:00Z')

    def test_supported_calendar_range_is_explicit(self):
        for date in ('1800-12-31', '2400-01-01'):
            with self.subTest(date=date):
                with self.assertRaises(ChartError) as error:
                    civil.local_to_utc(date, '12:00', 'UTC')
                self.assertEqual(error.exception.payload['error'], 'unsupported_date')


class MandalaTests(unittest.TestCase):
    def test_wheel_contains_each_gate_exactly_once(self):
        self.assertEqual(len(astro.GATE_WHEEL), 64)
        self.assertEqual(sorted(astro.GATE_WHEEL), list(range(1, 65)))

    def test_all_gate_and_line_boundaries(self):
        epsilon = 1e-8
        for index, gate in enumerate(astro.GATE_WHEEL):
            gate_start = 302 + index * 5.625
            with self.subTest(gate=gate):
                self.assertEqual(astro.gate_line(gate_start + epsilon), (gate, 1))
                self.assertEqual(astro.gate_line(gate_start + 5.625 - epsilon), (gate, 6))
                self.assertEqual(astro.gate_line(gate_start), (gate, 1))
            for line in range(1, 7):
                start = gate_start + (line - 1) * 0.9375
                end = start + 0.9375
                with self.subTest(gate=gate, line=line):
                    self.assertEqual(astro.gate_line(start + epsilon), (gate, line))
                    self.assertEqual(astro.gate_line(end - epsilon), (gate, line))

    def test_degree_wrap_and_known_anchor(self):
        self.assertEqual(astro.gate_line(302), (41, 1))
        self.assertEqual(astro.gate_line(302 - 1e-8), (60, 6))
        self.assertEqual(astro.gate_line(302 + 5.625), (19, 1))
        for longitude in (0, 12.345, 301.99999, 302, 359.99999):
            for turns in (-5, -1, 1, 5):
                with self.subTest(longitude=longitude, turns=turns):
                    self.assertEqual(astro.gate_line(longitude + 360 * turns), astro.gate_line(longitude))
        for invalid in (math.inf, -math.inf, math.nan):
            with self.assertRaises(ValueError):
                astro.gate_line(invalid)


class EphemerisTests(unittest.TestCase):
    def test_real_calculation_uses_swiss_files_not_moshier(self):
        for moment in (
            dt.datetime(1800, 10, 1, tzinfo=civil.UTC),
            dt.datetime(1972, 8, 2, 7, 30, tzinfo=civil.UTC),
            dt.datetime(2026, 9, 12, tzinfo=civil.UTC),
            dt.datetime(2399, 12, 31, tzinfo=civil.UTC),
        ):
            jd = astro.julian_tt(moment)
            for body in (astro.swe.SUN, astro.swe.MOON, astro.swe.TRUE_NODE, astro.swe.MERCURY,
                         astro.swe.VENUS, astro.swe.MARS, astro.swe.JUPITER, astro.swe.SATURN,
                         astro.swe.URANUS, astro.swe.NEPTUNE, astro.swe.PLUTO):
                with self.subTest(moment=moment, body=body):
                    values, flags = astro.swe.calc(jd, body, astro.FLAGS)
                    self.assertTrue(flags & astro.swe.FLG_SWIEPH)
                    self.assertFalse(flags & astro.swe.FLG_MOSEPH)
                    self.assertTrue(0 <= astro.longitude(jd, body) < 360)
                    self.assertTrue(math.isfinite(values[0]))

    def test_a_fallback_result_is_rejected(self):
        with mock.patch.object(astro.swe, 'calc', return_value=((42, 0, 1, 0, 0, 0), astro.swe.FLG_MOSEPH)):
            with self.assertRaises(ChartError) as error:
                astro.longitude(2451545, astro.swe.SUN)
            self.assertEqual(error.exception.payload['error'], 'ephemeris_unavailable')

    def test_solar_arc_in_winter_summer_and_across_calendar_year(self):
        for moment in (
            dt.datetime(1900, 1, 15, 12, tzinfo=civil.UTC),
            dt.datetime(1900, 7, 15, 12, tzinfo=civil.UTC),
            dt.datetime(2000, 1, 1, 0, tzinfo=civil.UTC),
            dt.datetime(2000, 7, 1, 0, tzinfo=civil.UTC),
            dt.datetime(2026, 1, 15, 12, tzinfo=civil.UTC),
            dt.datetime(2026, 7, 15, 12, tzinfo=civil.UTC),
        ):
            with self.subTest(moment=moment):
                birth_jd = astro.julian_tt(moment)
                design_jd, residual = astro.design_time(birth_jd)
                self.assertTrue(75 <= birth_jd - design_jd <= 100)
                self.assertLess(residual, 1e-7)
                actual_arc = (astro.longitude(birth_jd, astro.swe.SUN) - astro.longitude(design_jd, astro.swe.SUN)) % 360
                self.assertAlmostEqual(actual_arc, 88, places=7)
                if moment.month == 1:
                    self.assertEqual(astro.tt_to_datetime(design_jd).year, moment.year - 1)

    def test_tt_utc_roundtrip_preserves_modern_instants(self):
        for moment in (
            dt.datetime(1972, 8, 2, 7, 30, tzinfo=civil.UTC),
            dt.datetime(2026, 9, 12, 17, 45, 25, 123456, tzinfo=civil.UTC),
        ):
            with self.subTest(moment=moment):
                restored = astro.tt_to_datetime(astro.julian_tt(moment))
                self.assertLess(abs((restored - moment).total_seconds()), 0.001)

    def test_supplemental_astronomy_engine_design_moment(self):
        # Source: the Astronomy Engine author's worked 88-degree example:
        # https://github.com/cosinekitty/astronomy/discussions/306
        birth = dt.datetime(2023, 6, 12, tzinfo=civil.UTC)
        reference = dt.datetime(2023, 3, 13, 16, 3, 31, 528000, tzinfo=civil.UTC)
        design_jd, _ = astro.design_time(astro.julian_tt(birth))
        difference = abs((astro.tt_to_datetime(design_jd) - reference).total_seconds())
        self.assertLess(difference, 120, 'supplemental comparison, not an exact ephemeris guarantee')


class ChartTests(unittest.TestCase):
    @staticmethod
    def birth_request():
        return dict(mode='natal', name='Тестовая карта', date='1972-08-02', time='14:30',
                    city=dict(id='bangkok', name='Бангкок', timezone='Asia/Bangkok'))

    def check_stream(self, stream):
        expected = ['sun', 'earth', 'moon', 'north_node', 'south_node', 'mercury',
                    'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']
        self.assertEqual([item['planet'] for item in stream], expected)
        for item in stream:
            self.assertTrue(1 <= item['gate'] <= 64)
            self.assertTrue(1 <= item['line'] <= 6)
            self.assertTrue(0 <= item['longitude'] < 360)
            self.assertEqual((item['gate'], item['line']), astro.gate_line(item['longitude']))
        by_body = {item['planet']: item for item in stream}
        for first, opposite in [('sun', 'earth'), ('north_node', 'south_node')]:
            self.assertAlmostEqual((by_body[opposite]['longitude'] - by_body[first]['longitude']) % 360, 180, places=10)

    def test_natal_has_26_activations_and_two_distinct_moments(self):
        chart = calc.calculate(self.birth_request())['chart']
        self.assertEqual(chart['source'], 'calculated')
        self.assertEqual(chart['utc'], '1972-08-02T07:30:00Z')
        self.assertEqual(chart['utcOffset'], 'UTC+07:00')
        self.assertTrue(chart['designUtc'])
        for key in ('personality', 'design'):
            self.check_stream(chart['activations'][key])
            self.assertEqual(chart[key], sorted({item['gate'] for item in chart['activations'][key]}))
        self.assertEqual(sum(map(len, chart['activations'].values())), 26)
        self.assertEqual(chart['nodeModel'], 'true')
        self.assertEqual(chart['zodiac'], 'tropical-geocentric-apparent')

    def test_supplemental_bangkok_solar_gates(self):
        # Supplemental fixture from a different engine, not independent chart certification:
        # https://github.com/adamblvck/free-human-design/blob/main/test/profile.test.js
        chart = calc.calculate(self.birth_request())['chart']
        for side, expected in [('personality', (33, 3)), ('design', (24, 5))]:
            sun = next(item for item in chart['activations'][side] if item['planet'] == 'sun')
            self.assertEqual((sun['gate'], sun['line']), expected)

    def test_public_definedself_fixture_matches_all_26_gate_lines(self):
        # Adapted from DefinedSelf (2026), Cross-engine verification battery.
        # Source rows: https://definedself.com/data/verification-battery.csv
        # Method/attribution: https://definedself.com/data#verification-battery
        # License: CC BY 4.0, https://creativecommons.org/licenses/by/4.0/
        # Accessed 2026-09-12. Changes: one public synthetic birth moment selected;
        # body labels normalized, gate.line pairs copied into an offline fixture.
        # This compares bucket assignments against an independently published
        # source, not exact longitudes or certification by Jovian/myBodyGraph.
        # DefinedSelf uses a true node; its own two reference implementations
        # share wheel constants, so their agreement does not validate the wheel.
        order = ['sun', 'earth', 'north_node', 'south_node', 'moon', 'mercury',
                 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']
        expected = {
            'personality': ['55.3', '59.3', '31.2', '41.2', '46.2', '22.1', '41.3',
                            '17.4', '3.6', '24.5', '13.5', '41.4', '5.2'],
            'design': ['34.5', '20.5', '31.4', '41.4', '56.3', '1.3', '57.6',
                       '60.5', '42.6', '24.5', '13.1', '41.1', '9.5'],
        }
        chart = calc.calculate(dict(
            mode='natal', name='DefinedSelf public verification fixture',
            date='2000-02-21', time='19:25',
            city=dict(id='fixture-utc', name='UTC reference moment', timezone='UTC'),
        ))['chart']
        self.assertEqual(chart['utc'], '2000-02-21T19:25:00Z')
        for side in ('personality', 'design'):
            actual = {item['planet']: item for item in chart['activations'][side]}
            self.assertEqual(len(actual), 13)
            for planet, reference in zip(order, expected[side]):
                with self.subTest(side=side, planet=planet):
                    self.assertEqual((actual[planet]['gate'], actual[planet]['line']),
                                     tuple(map(int, reference.split('.'))))

    def test_current_transit_has_13_activations_and_no_design(self):
        before = dt.datetime.now(civil.UTC).replace(microsecond=0)
        chart = calc.calculate({'mode': 'transit'})['chart']
        after = dt.datetime.now(civil.UTC).replace(microsecond=0)
        moment = dt.datetime.fromisoformat(chart['utc'].replace('Z', '+00:00'))
        self.assertTrue(before <= moment <= after)
        self.assertEqual(chart['source'], 'transit')
        self.check_stream(chart['activations']['personality'])
        self.assertEqual(chart['activations']['design'], [])
        self.assertEqual(chart['design'], [])
        self.assertIsNone(chart['designUtc'])
        self.assertIsNone(chart['designArcResidualDegrees'])


if __name__ == '__main__':
    unittest.main()
