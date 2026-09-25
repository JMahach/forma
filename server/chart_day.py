"""Exact natal samples for each valid wall-clock minute of one local date.

The worker accepts only a date and an authoritative IANA zone. Names, chart IDs,
and the user's library never enter this process; no files are written.
"""
import datetime as dt
import json
import re
import sys
import zoneinfo

if __package__:
    from . import calculator as calc
else:
    import calculator as calc

PLANETS = ('sun', 'moon', 'north_node', 'mercury', 'venus', 'mars', 'jupiter',
           'saturn', 'uranus', 'neptune', 'pluto')


def local_minutes(date, timezone):
    if not isinstance(date, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):
        raise calc.ChartError('invalid_date', 'Нужна дата рождения в формате YYYY-MM-DD.')
    try:
        day = dt.date.fromisoformat(date)
    except ValueError:
        raise calc.ChartError('invalid_date', 'Некорректная дата рождения.')
    if not 1801 <= day.year <= 2399:
        raise calc.ChartError('unsupported_date', 'Доступны даты с 1801 по 2399 год.')
    try:
        zone = zoneinfo.ZoneInfo(timezone)
    except (ValueError, TypeError, zoneinfo.ZoneInfoNotFoundError):
        raise calc.ChartError('invalid_timezone', 'Неизвестный часовой пояс города.')
    # Enumerating wall-clock minute labels avoids assuming midnight exists or
    # that historical UTC offsets are whole minutes. Both folds are retained.
    unique = {}
    for minute in range(1440):
        time = f'{minute // 60:02d}:{minute % 60:02d}'
        for fold in (0, 1):
            try:
                moment, offset, actual_fold = calc.local_to_utc(date, time, timezone, fold)
            except calc.ChartError as error:
                if error.payload['error'] == 'nonexistent_time':
                    continue
                raise
            unique[moment] = (moment, offset, actual_fold,
                              int(moment.astimezone(zone).utcoffset().total_seconds()))
    if not unique:
        raise calc.ChartError('nonexistent_date', 'Этот местный день был пропущен при смене часового пояса.')
    return [unique[moment] for moment in sorted(unique)]


def calculate_day(date, timezone):
    minutes = local_minutes(date, timezone)
    columns = [[] for _ in range(24)]
    segments = []
    previous = None
    for index, (moment, offset, fold, offset_seconds) in enumerate(minutes):
        if (previous is None or moment - previous[0] != dt.timedelta(minutes=1)
                or (offset, fold) != previous[1:3]):
            segments.append(dict(index=index, startUtc=calc.iso(moment),
                                 utcOffset=offset, offsetSeconds=offset_seconds, fold=fold))
        jd = calc.julian_tt(moment)
        design_jd, residual = calc.design_time(jd)
        for side, side_jd in enumerate((jd, design_jd)):
            values = {entry['planet']: entry['longitude'] for entry in calc.activations(side_jd)}
            for column, planet in enumerate(PLANETS):
                columns[side * 11 + column].append(values[planet])
        # Match the existing API's second precision exactly (no recomputation
        # from the rounded UTC label when materializing Design activations).
        design_iso = calc.iso(calc.tt_to_datetime(design_jd))
        columns[22].append(int(dt.datetime.fromisoformat(design_iso.replace('Z', '+00:00')).timestamp()))
        columns[23].append(residual)
        previous = (moment, offset, fold)
    return dict(date=date, timezone=timezone, startUtc=calc.iso(minutes[0][0]),
                stepSeconds=60, samples=len(minutes), segments=segments, columns=columns,
                engine='Swiss Ephemeris ' + calc.swe.version,
                ephemeris='Swiss files: sepl_18.se1 + semo_18.se1',
                timezoneDatabase='IANA tzdata ' + calc.tzdata.__version__,
                nodeModel='true', zodiac='tropical-geocentric-apparent')


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.read(1024))
        if not isinstance(request, dict):
            raise calc.ChartError('invalid_request', 'Некорректные данные расчёта.')
        result = calculate_day(request.get('date'), request.get('timezone'))
    except calc.ChartError as error:
        result = error.payload
    except Exception:
        result = dict(error='calculation_failed', message='Не удалось подготовить день рождения.')
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False))
