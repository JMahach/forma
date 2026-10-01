"""Batch sampling uses the unchanged astronomical calculator, in UTC minutes."""
import datetime as dt
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from server.python import astronomy as astro
from server.python import civil_time as civil
from server.python.errors import ChartError
from server.python import transit_day
from server.python import calculator


class TransitDayTests(unittest.TestCase):
    def test_exact_date_validation(self):
        for date in (None, [], '2026-2-01', '2026-02-30', '2026-01-01T00:00Z', '../2026-01-01'):
            with self.subTest(date=date), self.assertRaises(ChartError) as error:
                transit_day.calculate_day(date)
            self.assertEqual(error.exception.payload['error'], 'invalid_date')
        for date in ('1800-12-31', '2400-01-01'):
            with self.assertRaises(ChartError) as error:
                transit_day.calculate_day(date)
            self.assertEqual(error.exception.payload['error'], 'unsupported_date')

    def test_month_and_leap_day_are_exactly_1440_utc_minutes(self):
        for date in ('2024-02-29', '2026-09-30', '2026-12-31'):
            moments = []
            def julian(moment):
                moments.append(moment)
                return 0
            values = {planet: index + .125 for index, planet in enumerate(transit_day.PLANETS)}
            design_moment = dt.datetime(2026, 1, 1, tzinfo=civil.UTC)
            with mock.patch.object(astro, 'julian_tt', side_effect=julian), mock.patch.object(astro, 'longitudes', return_value=values), mock.patch.object(astro, 'design_time', return_value=(-88, 1e-12)), mock.patch.object(astro, 'tt_to_datetime', return_value=design_moment):
                day = transit_day.calculate_day(date)
            self.assertEqual(day['startUtc'], date + 'T00:00:00Z')
            self.assertEqual(day['samples'], 1440)
            self.assertEqual(day['stepSeconds'], 60)
            self.assertEqual(len(day['columns']), 24)
            self.assertEqual(civil.iso(moments[-1]), date + 'T23:59:00Z')
            self.assertTrue(all(moment.tzinfo is civil.UTC for moment in moments))
            self.assertTrue(all(b - a == dt.timedelta(minutes=1) for a, b in zip(moments, moments[1:])))
            for index, column in enumerate(day['columns'][:22]):
                self.assertEqual(column, [index % 11 + .125] * 1440)
            self.assertEqual(day['columns'][22], [int(design_moment.timestamp())] * 1440)
            self.assertEqual(day['columns'][23], [1e-12] * 1440)

    def test_real_batch_matches_every_scalar_natal_side_time_and_residual(self):
        with mock.patch.object(astro, 'activations', side_effect=AssertionError('No chart formatting')), mock.patch.object(astro, 'gate_line', side_effect=AssertionError('No gate/line work')):
            day = transit_day.calculate_day('2026-09-24')
        start = dt.datetime(2026, 9, 24, tzinfo=civil.UTC)
        for minute in range(1440):
            moment = start + dt.timedelta(minutes=minute)
            reference = calculator.calculate(dict(mode='natal', name='Transit parity', date='2026-09-24',
                time=moment.strftime('%H:%M'), city=dict(id='utc', name='UTC', timezone='UTC')))['chart']
            for side, name in enumerate(('personality', 'design')):
                values = {entry['planet']: entry['longitude'] for entry in reference['activations'][name]}
                for index, planet in enumerate(transit_day.PLANETS):
                    self.assertEqual(day['columns'][side * 11 + index][minute].hex(), values[planet].hex())
            self.assertEqual(civil.iso(dt.datetime.fromtimestamp(day['columns'][22][minute], civil.UTC)), reference['designUtc'])
            self.assertEqual(day['columns'][23][minute].hex(), reference['designArcResidualDegrees'].hex())
        self.assertEqual(day['engine'], 'Swiss Ephemeris ' + astro.swe.version)
        self.assertEqual(day['timezoneDatabase'], 'IANA tzdata ' + civil.tzdata.__version__)
        self.assertEqual(day['nodeModel'], 'true')
        self.assertEqual(day['zodiac'], 'tropical-geocentric-apparent')


if __name__ == '__main__':
    unittest.main()
