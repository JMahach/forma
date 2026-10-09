"""Exact geocentric return crossings and derived charts; private JSON worker.

Full turns of unwrapped longitude identify cycles. Retrograde passages through
one turn stay in that cycle, while passages through the birth turn are excluded.
Station points split scan intervals before crossings are refined.
"""
import datetime as dt
import json
import math
import re
import sys

if __package__:
    from . import astronomy as astro
    from . import civil_time as civil, date_limits as dates
    from .return_index import (BODIES, YEAR_DAYS, position,
        angle_delta, bisect_root, find_crossings, has_completed_return)
    from .errors import ChartError
else:
    import astronomy as astro
    import civil_time as civil
    import date_limits as dates
    from return_index import (BODIES, YEAR_DAYS, position,
        angle_delta, bisect_root, find_crossings, has_completed_return)
    from errors import ChartError

def exact_iso(moment):
    return moment.astimezone(civil.UTC).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def parse_utc(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z', value):
        raise ChartError('invalid_datetime', 'Нужен точный момент UTC с датой и временем.')
    try:
        moment = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ChartError('invalid_datetime', 'Некорректный момент UTC.')
    if not dates.full_range_year(moment.year):
        raise ChartError('unsupported_date', 'Доступны даты с 1801 по 2399 год.')
    return moment


def validate_birth_body(request):
    if not isinstance(request, dict):
        raise ChartError('invalid_request', 'Некорректные данные циклов.')
    birth = parse_utc(request.get('birthUtc'))
    body = request.get('body')
    if not isinstance(body, str) or body not in BODIES:
        raise ChartError('invalid_body', 'Неизвестный вид возврата.')
    return birth, body


def search_events(birth, body, from_age, to_age):
    start = astro.julian_tt(birth)
    # Age is elapsed civil UTC time in mean Gregorian years, not orbital period.
    end_moment = birth + dt.timedelta(days=to_age * YEAR_DAYS)
    if end_moment >= dates.SUPPORTED_END_EXCLUSIVE:
        raise ChartError('unsupported_date', 'Диапазон возвратов выходит за доступные эфемериды: до конца 2399 года.')
    end = astro.julian_tt(end_moment)
    roots = find_crossings(body, start, end)
    counters, events = {}, []
    for crossing in roots:
        cycle = crossing['cycle']
        counters[cycle] = counters.get(cycle, 0) + 1
        moment = astro.tt_to_datetime(crossing['jd'])
        age = (moment - birth).total_seconds() / (86400 * YEAR_DAYS)
        if age + 1e-10 < from_age or age > to_age + 1e-10:
            continue
        utc = exact_iso(moment)
        events.append({'id': f'{body}:{utc}', 'body': body, 'utc': utc, 'age': age, 'cycle': cycle,
            'pass': counters[cycle], 'cycleId': f'{body}:{cycle}', 'direction': crossing['direction']})
    return events


def events(request):
    birth, body = validate_birth_body(request)
    low, high = request.get('fromAge', 0), request.get('toAge', dates.LIFE_SPAN_YEARS)
    if any(isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) for value in (low, high)) or not 0 <= low < high <= 300 or high - low > 120:
        raise ChartError('invalid_range', 'Выберите возраст от 0 до 300 лет, не больше 120 лет за один запрос.')
    found = search_events(birth, body, low, high)
    return dict(events=found, range=dict(fromAge=low, toAge=high), meta=dict(
        engine='Swiss Ephemeris ' + astro.swe.version, nodeModel='true', zodiac='tropical-geocentric-apparent',
        ephemeris='Swiss files: sepl_18.se1 + semo_18.se1' + (' + seas_18.se1' if body == 'chiron' else ''),
        primaryPass='first', cycleRule='unwrapped-longitude', ageYearDays=YEAR_DAYS))


def chart(request):
    birth, body = validate_birth_body(request)
    requested = parse_utc(request.get('eventUtc'))
    age = (requested - birth).total_seconds() / (86400 * YEAR_DAYS)
    if not 0 < age <= 300:
        raise ChartError('invalid_event', 'Момент возврата должен быть после рождения в пределах 300 лет.')
    timezone = request.get('timezone', 'UTC')
    try:
        if not isinstance(timezone, str) or len(timezone) > 160:
            raise ValueError()
        zone = civil.zoneinfo.ZoneInfo(timezone)
    except (ValueError, TypeError, civil.zoneinfo.ZoneInfoNotFoundError):
        raise ChartError('invalid_timezone', 'Неизвестный часовой пояс.')
    # The event list owns cycle/pass metadata. Opening its known UTC never
    # repeats the life search, even after the server's events cache expires.
    birth_jd = astro.julian_tt(birth)
    origin = position(birth_jd, body)[0]
    target = origin + BODIES[body][2] * BODIES[body][3]
    jd = astro.julian_tt(requested)
    longitude = position(jd, body)[0]
    error = angle_delta(longitude, target)
    moment, utc = requested, request['eventUtc']
    if not re.search(r'\.\d{6}Z$', utc) or abs(error) > 1e-7:
        # Rounded external requests retain the existing one-second contract.
        # Refine only this tiny interval, never a history of previous returns.
        left = astro.julian_tt(max(birth, requested - dt.timedelta(seconds=1)))
        right = astro.julian_tt(min(dates.SUPPORTED_END_EXCLUSIVE - dt.timedelta(microseconds=100),
            requested + dt.timedelta(seconds=1)))
        def residual_at(stamp):
            return angle_delta(position(stamp, body)[0], target)
        low, high = residual_at(left), residual_at(right)
        if low * high > 0 or abs(high - low) > 180:
            raise ChartError('invalid_event', 'Этот момент не является точным возвратом выбранного тела.')
        jd = bisect_root(residual_at, left, right)
        moment = astro.tt_to_datetime(jd)
        longitude = position(jd, body)[0]
        if abs(angle_delta(longitude, target)) > 1e-7 or moment <= birth or abs((moment-requested).total_seconds()) > 1:
            raise ChartError('invalid_event', 'Этот момент не является точным возвратом выбранного тела.')
        utc = exact_iso(moment)
    if not has_completed_return(body, birth_jd, jd, origin, longitude):
        raise ChartError('invalid_event', 'Этот момент не является возвратом после полного оборота выбранного тела.')
    design_jd, residual = astro.design_time(jd)
    personality, design = astro.activations(jd), astro.activations(design_jd)
    local, now = moment.astimezone(zone), civil.iso(dt.datetime.now(civil.UTC))
    result = dict(id=None, name=BODIES[body][4], source='calculated',
        personality=sorted({item['gate'] for item in personality}), design=sorted({item['gate'] for item in design}),
        activations=dict(personality=personality, design=design), utc=utc, designUtc=exact_iso(astro.tt_to_datetime(design_jd)),
        birthDate=local.strftime('%Y-%m-%d'), birthTime=local.strftime('%H:%M'), birthPlace='', timezone=timezone,
        utcOffset=civil.offset_label(local.utcoffset()), fold=local.fold, cityId=None, city=None,
        engine='Swiss Ephemeris ' + astro.swe.version, ephemeris='Swiss files: sepl_18.se1 + semo_18.se1',
        timezoneDatabase='IANA tzdata ' + civil.tzdata.__version__, nodeModel='true', zodiac='tropical-geocentric-apparent',
        designArcResidualDegrees=residual, updatedAt=now, createdAt=now, note='')
    return dict(chart=result)


def calculate(request):
    if not isinstance(request, dict):
        raise ChartError('invalid_request', 'Некорректные данные циклов.')
    action = request.get('action')
    if action == 'events':
        return events(request)
    if action == 'chart':
        return chart(request)
    raise ChartError('invalid_request', 'Неизвестный режим циклов.')


if __name__ == '__main__':
    try:
        result = calculate(json.loads(sys.stdin.read(4096)))
    except ChartError as error:
        result = error.payload
    except Exception:
        result = dict(error='cycle_search_failed', message='Не удалось рассчитать возвраты. Проверьте исходные данные и эфемериды.')
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
