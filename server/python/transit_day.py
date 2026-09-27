"""One UTC day of exact minute samples in one process; no natal calculation."""
import datetime as dt
import json
import re
import sys

if __package__:
    from . import astronomy as astro
    from . import civil_time as civil
    from .errors import ChartError
else:
    import astronomy as astro
    import civil_time as civil
    from errors import ChartError

PLANETS = ('sun', 'moon', 'north_node', 'mercury', 'venus', 'mars', 'jupiter',
           'saturn', 'uranus', 'neptune', 'pluto')


def calculate_day(date):
    if not isinstance(date, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):
        raise ChartError('invalid_date', 'Нужна дата UTC в формате YYYY-MM-DD.')
    try:
        start = dt.datetime.combine(dt.date.fromisoformat(date), dt.time(), civil.UTC)
    except ValueError:
        raise ChartError('invalid_date', 'Некорректная дата UTC.')
    if not 1801 <= start.year <= 2399:
        raise ChartError('unsupported_date', 'Доступны даты с 1801 по 2399 год.')
    columns = [[] for _ in PLANETS]
    for minute in range(1440):
        moment = start + dt.timedelta(minutes=minute)
        values = {entry['planet']: entry['longitude']
                  for entry in astro.activations(astro.julian_tt(moment))}
        for column, planet in zip(columns, PLANETS):
            column.append(values[planet])
    return dict(
        date=date, startUtc=civil.iso(start), stepSeconds=60, samples=1440,
        columns=columns, engine='Swiss Ephemeris ' + astro.swe.version,
        ephemeris='Swiss files: sepl_18.se1 + semo_18.se1',
        timezoneDatabase='IANA tzdata ' + civil.tzdata.__version__,
        nodeModel='true', zodiac='tropical-geocentric-apparent',
    )


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.read(256))
        if not isinstance(request, dict):
            raise ChartError('invalid_request', 'Некорректные данные расчёта.')
        result = calculate_day(request.get('date'))
    except ChartError as error:
        result = error.payload
    except Exception:
        result = dict(error='calculation_failed', message='Не удалось подготовить дневной транзит.')
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False))
