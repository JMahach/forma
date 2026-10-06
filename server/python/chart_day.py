"""Exact natal samples for each valid wall-clock minute of one local date.

The worker accepts only a date and an authoritative IANA zone. Names, chart IDs,
and the user's library never enter this process; no files are written.
"""
import datetime as dt
import json
import sys

if __package__:
    from . import astronomy as astro
    from . import civil_time as civil
    from .errors import ChartError
else:
    import astronomy as astro
    import civil_time as civil
    from errors import ChartError


def calculate_day(date, timezone):
    minutes = civil.local_minutes(date, timezone)
    segments = []
    previous = None
    for index, (moment, offset, fold, offset_seconds) in enumerate(minutes):
        if (previous is None or moment - previous[0] != dt.timedelta(minutes=1)
                or (offset, fold) != previous[1:3]):
            segments.append(dict(index=index, startUtc=civil.iso(moment),
                                 utcOffset=offset, offsetSeconds=offset_seconds, fold=fold))
        previous = (moment, offset, fold)
    columns = astro.sample_columns(item[0] for item in minutes)
    return dict(date=date, timezone=timezone, startUtc=civil.iso(minutes[0][0]),
                stepSeconds=60, samples=len(minutes), segments=segments, columns=columns,
                engine='Swiss Ephemeris ' + astro.swe.version,
                ephemeris='Swiss files: sepl_18.se1 + semo_18.se1',
                timezoneDatabase='IANA tzdata ' + civil.tzdata.__version__,
                nodeModel='true', zodiac='tropical-geocentric-apparent')


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.read(1024))
        if not isinstance(request, dict):
            raise ChartError('invalid_request', 'Некорректные данные расчёта.')
        result = calculate_day(request.get('date'), request.get('timezone'))
    except ChartError as error:
        result = error.payload
    except Exception:
        result = dict(error='calculation_failed', message='Не удалось подготовить день рождения.')
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False))
