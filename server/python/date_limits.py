"""One range policy for natal admission and full-range calculations."""
import calendar
import datetime as dt
from pathlib import Path
import re

if __package__:
    from .errors import ChartError
else:
    from errors import ChartError

# Read only the three integer declarations, never evaluate JavaScript.
_source = (Path(__file__).resolve().parents[2] / 'shared/date-limits.js').read_text()
def _integer(name):
    match = re.search(r'^export const ' + re.escape(name) + r' = (\d+);$', _source, re.MULTILINE)
    if not match:
        raise ValueError('Missing shared date limit: ' + name)
    return int(match.group(1))

EPHEMERIS_FIRST_YEAR = _integer('EPHEMERIS_FIRST_YEAR')
EPHEMERIS_LAST_YEAR = _integer('EPHEMERIS_LAST_YEAR')
LIFE_SPAN_YEARS = _integer('LIFE_SPAN_YEARS')
NATAL_LAST_YEAR = EPHEMERIS_LAST_YEAR - LIFE_SPAN_YEARS
SUPPORTED_START = dt.datetime(EPHEMERIS_FIRST_YEAR, 1, 1, tzinfo=dt.timezone.utc)
SUPPORTED_END_EXCLUSIVE = dt.datetime(EPHEMERIS_LAST_YEAR + 1, 1, 1, tzinfo=dt.timezone.utc)
NATAL_DATE_MESSAGE = (f'Натальные карты доступны с {EPHEMERIS_FIRST_YEAR} по {NATAL_LAST_YEAR} год: '
                      f'впереди нужны полные {LIFE_SPAN_YEARS} лет данных.')


def full_range_year(year):
    return EPHEMERIS_FIRST_YEAR <= year <= EPHEMERIS_LAST_YEAR


def calendar_anniversary(moment, years=LIFE_SPAN_YEARS):
    year = moment.year + years
    if moment.month == 2 and moment.day == 29 and not calendar.isleap(year):
        return moment.replace(year=year, month=3, day=1)
    return moment.replace(year=year)


def validate_natal_date(value):
    try:
        date = dt.date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ChartError('invalid_datetime', 'Проверьте дату, время и выбранный город.')
    if not EPHEMERIS_FIRST_YEAR <= date.year <= NATAL_LAST_YEAR:
        raise ChartError('unsupported_date', NATAL_DATE_MESSAGE)


def validate_natal_moment(moment):
    if moment < SUPPORTED_START or calendar_anniversary(moment) >= SUPPORTED_END_EXCLUSIVE:
        raise ChartError('unsupported_date', NATAL_DATE_MESSAGE)
