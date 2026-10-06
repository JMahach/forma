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
    from . import civil_time as civil
    from .errors import ChartError
else:
    import astronomy as astro
    import civil_time as civil
    from errors import ChartError

YEAR_DAYS = 365.2425
SECOND_DAYS = 1 / 86400
ANGLE_TOLERANCE = 1e-8
# Conservative scan intervals; each is split at its midpoint and at stations.
BODIES = {
    'sun': (astro.swe.SUN, 8, 1, 0, 'Соляр'),
    'moon': (astro.swe.MOON, 1, 1, 0, 'Лунар'),
    'north_node': (astro.swe.TRUE_NODE, 1, -1, 0, 'Возврат лунных узлов'),
    'mercury': (astro.swe.MERCURY, 2, 1, 0, 'Возврат Меркурия'),
    'venus': (astro.swe.VENUS, 3, 1, 0, 'Возврат Венеры'),
    'mars': (astro.swe.MARS, 4, 1, 0, 'Возврат Марса'),
    'jupiter': (astro.swe.JUPITER, 8, 1, 0, 'Возврат Юпитера'),
    'saturn': (astro.swe.SATURN, 8, 1, 0, 'Возврат Сатурна'),
    'uranus': (astro.swe.URANUS, 10, 1, 0, 'Возврат Урана'),
    'uranus_opposition': (astro.swe.URANUS, 10, 1, 180, 'Оппозиция Урана'),
    'neptune': (astro.swe.NEPTUNE, 10, 1, 0, 'Возврат Нептуна'),
    'pluto': (astro.swe.PLUTO, 10, 1, 0, 'Возврат Плутона'),
    'chiron': (astro.swe.CHIRON, 8, 1, 0, 'Возврат Хирона'),
}


def exact_iso(moment):
    return moment.astimezone(civil.UTC).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def parse_utc(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z', value):
        raise ChartError('invalid_datetime', 'Нужен точный момент UTC с датой и временем.')
    try:
        moment = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ChartError('invalid_datetime', 'Некорректный момент UTC.')
    if not 1801 <= moment.year <= 2399:
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


def position(jd, body):
    try:
        values, used = astro.swe.calc(jd, BODIES[body][0], astro.FLAGS)
    except astro.swe.Error:
        raise ChartError('ephemeris_unavailable', 'Точные эфемериды этого тела для выбранной даты недоступны.', body=body)
    if not used & astro.swe.FLG_SWIEPH or used & astro.swe.FLG_MOSEPH:
        raise ChartError('ephemeris_unavailable', 'Точные эфемериды недоступны. Приближённый расчёт отключён.', body=body)
    return values[0] % 360, values[3]


def angle_delta(a, b):
    return (a - b + 180) % 360 - 180


def bisect_root(function, left, right):
    low = function(left)
    high = function(right)
    if abs(low) < 1e-12:
        return left
    if abs(high) < 1e-12:
        return right
    if low * high > 0:
        raise ChartError('cycle_search_failed', 'Не удалось уточнить точный момент возврата.')
    for _ in range(56):
        middle = (left + right) / 2
        if middle == left or middle == right:
            break
        value = function(middle)
        if value == 0:
            return middle
        if low * value <= 0:
            right = middle
        else:
            left, low = middle, value
    return (left + right) / 2


def scan_crossings(sample, start, end, step, direction=1, offset=0):
    """Return every exact passage of a new winding, including tangent stations.

    sample(jd) supplies longitude and longitude speed in degrees/day. Midpoint
    sampling and station subdivision catch paired roots even when both ends of
    an interval are on the same side of the target. The remaining angular span
    is small, so 0/360 wrapping cannot manufacture a root at the antipode.
    """
    origin, speed = sample(start)
    previous = (start, origin, speed)
    phase = 0.0
    events = []
    left = start
    while left < end:
        right = min(end, left + step)
        middle = (left + right) / 2
        points = [(middle, *sample(middle)), (right, *sample(right))]
        for point in points:
            a, lon_a, speed_a = previous
            b, lon_b, speed_b = point
            partitions = []
            if speed_a * speed_b < 0:
                station = bisect_root(lambda t: sample(t)[1], a, b)
                partitions.append((station, *sample(station)))
            partitions.append(point)
            for endpoint in partitions:
                t, lon, velocity = endpoint
                next_phase = phase + angle_delta(lon, lon_a)
                low, high = sorted((direction * phase, direction * next_phase))
                first = max(0 if offset else 1, math.ceil((low - offset - ANGLE_TOLERANCE) / 360))
                last = math.floor((high - offset + ANGLE_TOLERANCE) / 360)
                for turn in range(first, last + 1):
                    target = direction * (turn * 360 + offset)
                    f_a, f_b = phase - target, next_phase - target
                    if abs(f_a) <= ANGLE_TOLERANCE:
                        root = a
                    elif abs(f_b) <= ANGLE_TOLERANCE:
                        root = t
                    elif f_a * f_b < 0:
                        root = bisect_root(lambda moment: phase + angle_delta(sample(moment)[0], lon_a) - target, a, t)
                    else:
                        continue
                    if root <= start + SECOND_DAYS or any(abs(root - item['jd']) < SECOND_DAYS for item in events[-3:]):
                        continue
                    root_lon, root_speed = sample(root)
                    if abs(angle_delta(root_lon, (origin + direction * offset) % 360)) > 1e-7:
                        raise ChartError('cycle_search_failed', 'Невязка точного возврата превышает допустимую.')
                    events.append(dict(jd=root, cycle=turn + (1 if offset else 0),
                        direction='stationary' if abs(root_speed) < 1e-9 else 'direct' if root_speed > 0 else 'retrograde'))
                phase = next_phase
                a, lon_a, speed_a = endpoint
            previous = point
        left = right
    return events


def search_events(birth, body, from_age, to_age, clip_ephemeris=False):
    start = astro.julian_tt(birth)
    # Age is elapsed civil UTC time in mean Gregorian years, not orbital period.
    end_moment = birth + dt.timedelta(days=to_age * YEAR_DAYS)
    if end_moment.year > 2399:
        if not clip_ephemeris:
            raise ChartError('unsupported_date', 'Диапазон возвратов выходит за доступные эфемериды: до конца 2399 года.')
        end_moment = dt.datetime(2399, 12, 31, 23, 59, 59, 999999, tzinfo=civil.UTC)
    end = astro.julian_tt(end_moment)
    _, step, direction, offset, _ = BODIES[body]
    roots = scan_crossings(lambda jd: position(jd, body), start, end, step, direction, offset)
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
    low, high = request.get('fromAge', 0), request.get('toAge', 100)
    if any(isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) for value in (low, high)) or not 0 <= low < high <= 300 or high - low > 120:
        raise ChartError('invalid_range', 'Выберите возраст от 0 до 300 лет, не больше 120 лет за один запрос.')
    found = search_events(birth, body, low, high)
    return dict(events=found, range=dict(fromAge=low, toAge=high), meta=dict(
        engine='Swiss Ephemeris ' + astro.swe.version, nodeModel='true', zodiac='tropical-geocentric-apparent',
        ephemeris='Swiss files: sepl_18.se1 + semo_18.se1' + (' + seas_18.se1' if body == 'chiron' else ''),
        primaryPass='first', cycleRule='unwrapped-longitude', ageYearDays=YEAR_DAYS))


def chart(request, *, verified_event=None):
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
    if verified_event is None:
        nearby = search_events(birth, body, max(0, age - 2 / YEAR_DAYS), min(300, age + 2 / YEAR_DAYS), clip_ephemeris=True)
        event = next((item for item in nearby if abs((parse_utc(item['utc']) - requested).total_seconds()) <= 1), None)
    else:
        # Only the server's validated RAM result supplies winding/pass metadata.
        # The public request cannot provide this separate private argument.
        event = verified_event if isinstance(verified_event, dict) and verified_event.get('body') == body \
            and verified_event.get('utc') == request.get('eventUtc') else None
    if event is None:
        raise ChartError('invalid_event', 'Этот момент не является точным возвратом выбранного тела.')
    moment = parse_utc(event['utc'])
    jd = astro.julian_tt(moment)
    if verified_event is not None:
        origin = position(astro.julian_tt(birth), body)[0]
        longitude = position(jd, body)[0]
        target = origin + BODIES[body][2] * BODIES[body][3]
        if abs(angle_delta(longitude, target)) > 1e-7:
            raise ChartError('invalid_event', 'Этот момент не является точным возвратом выбранного тела.')
    design_jd, residual = astro.design_time(jd)
    personality, design = astro.activations(jd), astro.activations(design_jd)
    local, now = moment.astimezone(zone), civil.iso(dt.datetime.now(civil.UTC))
    result = dict(id=None, name=BODIES[body][4], source='calculated',
        personality=sorted({item['gate'] for item in personality}), design=sorted({item['gate'] for item in design}),
        activations=dict(personality=personality, design=design), utc=event['utc'], designUtc=exact_iso(astro.tt_to_datetime(design_jd)),
        birthDate=local.strftime('%Y-%m-%d'), birthTime=local.strftime('%H:%M'), birthPlace='', timezone=timezone,
        utcOffset=civil.offset_label(local.utcoffset()), fold=local.fold, cityId=None, city=None,
        engine='Swiss Ephemeris ' + astro.swe.version, ephemeris='Swiss files: sepl_18.se1 + semo_18.se1',
        timezoneDatabase='IANA tzdata ' + civil.tzdata.__version__, nodeModel='true', zodiac='tropical-geocentric-apparent',
        designArcResidualDegrees=residual, updatedAt=now, createdAt=now, note='')
    return dict(chart=result, event=event)


def calculate(request):
    if not isinstance(request, dict):
        raise ChartError('invalid_request', 'Некорректные данные циклов.')
    action = request.get('action')
    if action == 'events':
        return events(request)
    if action == 'chart':
        return chart(request, verified_event=request.get('verifiedEvent'))
    raise ChartError('invalid_request', 'Неизвестный режим циклов.')


if __name__ == '__main__':
    try:
        result = calculate(json.loads(sys.stdin.read(4096)))
    except ChartError as error:
        result = error.payload
    except Exception:
        result = dict(error='cycle_search_failed', message='Не удалось рассчитать возвраты. Проверьте исходные данные и эфемериды.')
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
