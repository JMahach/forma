"""Swiss Ephemeris longitudes, tropical gate wheel and exact 88-degree search."""
import datetime as dt
import math
import pathlib
import swisseph as swe

if __package__:
    from .errors import ChartError
else:
    from errors import ChartError

ROOT = pathlib.Path(__file__).resolve().parents[2]
swe.set_ephe_path(str(ROOT / 'data' / 'ephe'))
FLAGS = swe.FLG_SWIEPH | swe.FLG_SPEED
UTC = dt.timezone.utc
GATE_WHEEL = [41,19,13,49,30,55,37,63,22,36,25,17,21,51,42,3,27,24,2,23,8,20,16,35,45,12,15,52,39,53,62,56,31,33,7,4,29,59,40,64,47,6,46,18,48,57,32,50,28,44,1,43,14,34,9,5,26,11,10,58,38,54,61,60]


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
