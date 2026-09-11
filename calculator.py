"""Local, deterministic chart calculations. JSON input/output; no external requests."""
import datetime as dt
import json
import math
import pathlib
import sys
import zoneinfo

import swisseph as swe
import tzdata

ROOT = pathlib.Path(__file__).parent
# Use the pinned package, not whichever database the operating system happens to have.
zoneinfo.reset_tzpath([])
swe.set_ephe_path(str(ROOT / 'data' / 'ephe'))
FLAGS = swe.FLG_SWIEPH | swe.FLG_SPEED
UTC = dt.timezone.utc
GATE_WHEEL = [41,19,13,49,30,55,37,63,22,36,25,17,21,51,42,3,27,24,2,23,8,20,16,35,45,12,15,52,39,53,62,56,31,33,7,4,29,59,40,64,47,6,46,18,48,57,32,50,28,44,1,43,14,34,9,5,26,11,10,58,38,54,61,60]


class ChartError(Exception):
    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.payload = dict(error=code, message=message, **extra)


def iso(moment):
    return moment.astimezone(UTC).isoformat(timespec='seconds').replace('+00:00', 'Z')


def offset_label(delta):
    seconds = int(delta.total_seconds())
    sign = '+' if seconds >= 0 else '−'
    hours, rest = divmod(abs(seconds), 3600)
    minutes, seconds = divmod(rest, 60)
    return f'UTC{sign}{hours:02d}:{minutes:02d}' + (f':{seconds:02d}' if seconds else '')


def local_to_utc(date, time, timezone, fold=None):
    try:
        local = dt.datetime.strptime(f'{date} {time}', '%Y-%m-%d %H:%M')
        zone = zoneinfo.ZoneInfo(timezone)
    except (ValueError, TypeError, zoneinfo.ZoneInfoNotFoundError):
        raise ChartError('invalid_datetime', 'Проверьте дату, время и выбранный город.')
    if not 1801 <= local.year <= 2399:
        raise ChartError('unsupported_date', 'Доступны даты с 1801 по 2399 год.')
    candidates = []
    for candidate_fold in (0, 1):
        aware = local.replace(tzinfo=zone, fold=candidate_fold)
        utc = aware.astimezone(UTC)
        if utc.astimezone(zone).replace(tzinfo=None) == local and all(existing[1] != utc for existing in candidates):
            candidates.append((candidate_fold, utc, aware.utcoffset()))
    if not candidates:
        raise ChartError('nonexistent_time', 'Такого местного времени не было из-за перевода часов. Уточните время рождения.')
    if len(candidates) > 1:
        choices = [dict(fold=f, utc=iso(u), label=offset_label(offset)) for f, u, offset in candidates]
        if fold not in (0, 1) or isinstance(fold, bool):
            raise ChartError('ambiguous_time', 'В этот день часы переводили назад. Это время встречалось дважды — выберите нужное смещение.', choices=choices)
        selected = next(candidate for candidate in candidates if candidate[0] == fold)
    else:
        selected = candidates[0]
    return selected[1], offset_label(selected[2]), selected[0]


def julian_tt(moment):
    moment = moment.astimezone(UTC)
    return swe.utc_to_jd(moment.year, moment.month, moment.day, moment.hour, moment.minute, moment.second + moment.microsecond / 1e6, swe.GREG_CAL)[0]


def tt_to_datetime(jd):
    y, m, d, h, minute, seconds = swe.jdet_to_utc(jd, swe.GREG_CAL)
    return dt.datetime(y, m, d, h, minute, tzinfo=UTC) + dt.timedelta(seconds=seconds)


def longitude(jd, body):
    values, used = swe.calc(jd, body, FLAGS)
    if not used & swe.FLG_SWIEPH or used & swe.FLG_MOSEPH:
        raise ChartError('ephemeris_unavailable', 'Точные файлы эфемерид недоступны для этой даты. Приближённый расчёт отключён.')
    return values[0] % 360


def gate_line(lon):
    if not math.isfinite(lon):
        raise ValueError('Longitude must be finite')
    position = (lon - 302.0) % 360
    index = int(position / 5.625)
    line = min(6, int((position - index * 5.625) / 0.9375) + 1)
    return GATE_WHEEL[index], line


def design_time(birth_jd):
    birth_sun = longitude(birth_jd, swe.SUN)
    low, high = birth_jd - 100, birth_jd - 75
    for _ in range(48):
        mid = (low + high) / 2
        arc = (birth_sun - longitude(mid, swe.SUN)) % 360
        if arc > 88:
            low = mid
        else:
            high = mid
    result = (low + high) / 2
    residual = abs((birth_sun - longitude(result, swe.SUN)) % 360 - 88)
    if residual > 1e-7:
        raise ChartError('design_search_failed', 'Не удалось точно определить момент дизайна.')
    return result, residual


def activations(jd):
    bodies = [('sun', swe.SUN), ('moon', swe.MOON), ('north_node', swe.TRUE_NODE), ('mercury', swe.MERCURY), ('venus', swe.VENUS), ('mars', swe.MARS), ('jupiter', swe.JUPITER), ('saturn', swe.SATURN), ('uranus', swe.URANUS), ('neptune', swe.NEPTUNE), ('pluto', swe.PLUTO)]
    values = {name: longitude(jd, body) for name, body in bodies}
    values['earth'] = (values['sun'] + 180) % 360
    values['south_node'] = (values['north_node'] + 180) % 360
    ordered = ['sun', 'earth', 'moon', 'north_node', 'south_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']
    return [dict(planet=name, longitude=values[name], gate=gate_line(values[name])[0], line=gate_line(values[name])[1]) for name in ordered]


def calculate(request):
    mode = request.get('mode', 'natal')
    city, offset, fold = None, 'UTC+00:00', 0
    if mode == 'transit':
        moment = dt.datetime.now(UTC).replace(microsecond=0)
        name, date, time, place, timezone = 'Текущий момент', moment.strftime('%Y-%m-%d'), moment.strftime('%H:%M'), '', 'UTC'
    elif mode == 'natal':
        city = request.get('city')
        if not isinstance(city, dict) or not city.get('timezone'):
            raise ChartError('city_required', 'Выберите город из списка подсказок.')
        name = str(request.get('name', '')).strip()[:80]
        if not name:
            raise ChartError('name_required', 'Добавьте имя карты.')
        date, time, place, timezone = request.get('date'), request.get('time'), city['name'], city['timezone']
        moment, offset, fold = local_to_utc(date, time, timezone, request.get('fold'))
    else:
        raise ChartError('invalid_mode', 'Неизвестный режим расчёта.')
    jd = julian_tt(moment)
    personality = activations(jd)
    design, design_utc, residual = [], None, None
    if mode == 'natal':
        design_jd, residual = design_time(jd)
        design = activations(design_jd)
        design_utc = iso(tt_to_datetime(design_jd))
    return {'chart': dict(
        id=None, name=name, personality=sorted(set(a['gate'] for a in personality)), design=sorted(set(a['gate'] for a in design)),
        source='transit' if mode == 'transit' else 'calculated', birthDate=date, birthTime=time, birthPlace=place, timezone=timezone,
        utc=iso(moment), utcOffset=offset, fold=fold, designUtc=design_utc, cityId=city['id'] if city else None, city=city,
        activations=dict(personality=personality, design=design), engine='Swiss Ephemeris ' + swe.version, ephemeris='Swiss files: sepl_18.se1 + semo_18.se1',
        timezoneDatabase='IANA tzdata ' + tzdata.__version__, nodeModel='true', zodiac='tropical-geocentric-apparent',
        designArcResidualDegrees=residual, updatedAt=iso(dt.datetime.now(UTC)), createdAt=iso(dt.datetime.now(UTC)), note='',
        verification='Engine/timezone regression checks and 26 gate-line matches to a published DefinedSelf fixture; official Human Design reference-chart validation pending.'
    )}


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.read(20000))
        if not isinstance(request, dict):
            raise ChartError('invalid_request', 'Некорректные данные расчёта.')
        result = calculate(request)
    except ChartError as error:
        result = error.payload
    except Exception as error:
        result = dict(error='calculation_failed', message='Не удалось выполнить расчёт. Проверьте исходные данные и локальные файлы эфемерид.')
    print(json.dumps(result, ensure_ascii=False))
