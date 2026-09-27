"""Personal day grids follow pinned tzdata and the original exact calculator."""
import datetime as dt
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from server.python import calculator as calc
from server.python import civil_time as civil
from server.python.errors import ChartError
from server.python import chart_day


class ChartDayTests(unittest.TestCase):
    def test_invalid_dates_and_zones(self):
        for date in (None, [], '1990-6-15', '2023-02-29', '1800-01-01', '2400-01-01'):
            with self.subTest(date=date), self.assertRaises(ChartError):
                civil.local_minutes(date, 'UTC')
        for zone in (None, [], '../UTC', 'No/Such_Zone'):
            with self.subTest(zone=zone), self.assertRaises(ChartError):
                civil.local_minutes('1990-06-15', zone)

    def test_short_long_half_hour_midnight_and_repeated_whole_days(self):
        for date, zone, count, first_time in (
            ('2024-03-10', 'America/New_York', 1380, '00:00'),
            ('2024-11-03', 'America/New_York', 1500, '00:00'),
            ('2026-10-04', 'Australia/Lord_Howe', 1410, '00:00'),
            ('2018-11-04', 'America/Sao_Paulo', 1380, '01:00'),
            ('1892-07-04', 'Pacific/Apia', 2880, '00:00'),
        ):
            with self.subTest(date=date, zone=zone):
                minutes = civil.local_minutes(date, zone)
                self.assertEqual(len(minutes), count)
                self.assertEqual((minutes[0][0] + dt.timedelta(seconds=minutes[0][3])).strftime('%H:%M'), first_time)
                self.assertTrue(all(a[0] < b[0] for a, b in zip(minutes, minutes[1:])))
                self.assertEqual(len({item[0] for item in minutes}), count)
        with self.assertRaises(ChartError) as failure:
            civil.local_minutes('2011-12-30', 'Pacific/Apia')
        self.assertEqual(failure.exception.payload['error'], 'nonexistent_date')

    def test_historical_second_offsets_and_repeated_minutes(self):
        minutes = civil.local_minutes('1900-01-01', 'Europe/Paris')
        self.assertEqual(civil.iso(minutes[0][0]), '1899-12-31T23:50:39Z')
        self.assertEqual(minutes[0][1], 'UTC+00:09:21')
        minutes = civil.local_minutes('2024-11-03', 'America/New_York')
        repeated = [item for item in minutes if (item[0] + dt.timedelta(seconds=item[3])).strftime('%H:%M') == '01:30']
        self.assertEqual([item[2] for item in repeated], [0, 1])
        self.assertEqual(repeated[1][0] - repeated[0][0], dt.timedelta(hours=1))

    def test_every_minute_matches_original_personality_design_and_residual(self):
        date, zone = '1990-06-15', 'Europe/Moscow'
        day = chart_day.calculate_day(date, zone)
        self.assertEqual(day['samples'], 1440)
        self.assertEqual(len(day['columns']), 24)
        self.assertEqual(day['segments'], [dict(index=0, startUtc='1990-06-14T20:00:00Z', utcOffset='UTC+04:00', offsetSeconds=14400, fold=0)])
        for minute in range(1440):
            chart = calc.calculate(dict(mode='natal', name='Independent regression', date=date,
                time=f'{minute // 60:02d}:{minute % 60:02d}', city=dict(id='test', name='Test', timezone=zone)))['chart']
            for side_index, side in enumerate(('personality', 'design')):
                expected = {item['planet']: item['longitude'] for item in chart['activations'][side]}
                for column, planet in enumerate(chart_day.PLANETS):
                    self.assertEqual(day['columns'][side_index * 11 + column][minute].hex(), expected[planet].hex())
            self.assertEqual(civil.iso(dt.datetime.fromtimestamp(day['columns'][22][minute], civil.UTC)), chart['designUtc'])
            self.assertEqual(day['columns'][23][minute].hex(), chart['designArcResidualDegrees'].hex())
        self.assertEqual(day['timezoneDatabase'], 'IANA tzdata ' + civil.tzdata.__version__)

    def test_segments_reconstruct_exact_historical_and_dst_utc_grid(self):
        for date, zone in (('1900-01-01', 'Europe/Paris'), ('1911-03-10', 'Europe/Paris'), ('2024-11-03', 'America/New_York')):
            with self.subTest(date=date, zone=zone):
                day = chart_day.calculate_day(date, zone)
                for index, (moment, offset, fold, offset_seconds) in enumerate(civil.local_minutes(date, zone)):
                    segment = next(item for item in reversed(day['segments']) if item['index'] <= index)
                    actual = dt.datetime.fromisoformat(segment['startUtc'].replace('Z', '+00:00')) + dt.timedelta(minutes=index - segment['index'])
                    self.assertEqual(actual, moment)
                    self.assertEqual((segment['utcOffset'], segment['fold'], segment['offsetSeconds']), (offset, fold, offset_seconds))


if __name__ == '__main__':
    unittest.main()
