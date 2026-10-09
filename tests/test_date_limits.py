"""Calendar anniversary policy, without ephemeris or prepared-file writes."""
import datetime as dt
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from server.python import date_limits as dates
from server.python.errors import ChartError


class CalendarAnniversaryTests(unittest.TestCase):
    def test_anniversary_keeps_the_birth_clock_and_uses_march_first_when_needed(self):
        for birth, years, expected in [
            ('2000-02-29T12:34:56.789123+00:00', 100, '2100-03-01T12:34:56.789123+00:00'),
            ('2000-02-29T12:34:56.789123+00:00', 1, '2001-03-01T12:34:56.789123+00:00'),
            ('1980-02-29T12:34:56.789123+00:00', 100, '2080-02-29T12:34:56.789123+00:00'),
            ('2000-02-29T12:34:56.789123+00:00', 400, '2400-02-29T12:34:56.789123+00:00'),
            ('2000-01-31T12:34:56.789123+00:00', 100, '2100-01-31T12:34:56.789123+00:00'),
        ]:
            with self.subTest(birth=birth, years=years):
                self.assertEqual(dates.calendar_anniversary(dt.datetime.fromisoformat(birth), years).isoformat(), expected)

    def test_existing_datetime_timezone_is_preserved(self):
        birth = dt.datetime.fromisoformat('2000-02-29T12:34:56.789123+03:00')
        anniversary = dates.calendar_anniversary(birth)
        self.assertEqual(anniversary.isoformat(), '2100-03-01T12:34:56.789123+03:00')
        self.assertIs(anniversary.tzinfo, birth.tzinfo)

    def test_natal_admission_and_ephemeris_bounds_are_unchanged(self):
        for date in ('1801-01-01', '2299-12-31'):
            dates.validate_natal_date(date)
        for date in ('1800-12-31', '2300-01-01'):
            with self.subTest(date=date), self.assertRaises(ChartError):
                dates.validate_natal_date(date)
        dates.validate_natal_moment(dt.datetime(2299, 12, 31, 23, 59, 59, tzinfo=dt.timezone.utc))
        with self.assertRaises(ChartError):
            dates.validate_natal_moment(dt.datetime(2300, 1, 1, tzinfo=dt.timezone.utc))
        self.assertTrue(dates.full_range_year(2399))
        self.assertFalse(dates.full_range_year(2400))


if __name__ == '__main__':
    unittest.main()
