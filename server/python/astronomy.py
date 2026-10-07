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
PLANET_BODIES = (
    ('sun', swe.SUN), ('moon', swe.MOON), ('north_node', swe.TRUE_NODE),
    ('mercury', swe.MERCURY), ('venus', swe.VENUS), ('mars', swe.MARS),
    ('jupiter', swe.JUPITER), ('saturn', swe.SATURN), ('uranus', swe.URANUS),
    ('neptune', swe.NEPTUNE), ('pluto', swe.PLUTO),
)

PERSONALITY_COLUMN = 0
DESIGN_COLUMN = len(PLANET_BODIES)
DESIGN_UNIX_SECONDS_COLUMN = DESIGN_COLUMN + len(PLANET_BODIES)
DESIGN_RESIDUAL_COLUMN = DESIGN_UNIX_SECONDS_COLUMN + 1
MOMENT_COLUMN_COUNT = DESIGN_RESIDUAL_COLUMN + 1
MOMENT_FIELDS = tuple(f'{side}.{planet}' for side in ('personality', 'design') for planet, _ in PLANET_BODIES) + (
    'exactDesignUnixSeconds', 'designArcResidualDegrees',
)


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


def design_time(birth_jd, *, hint=None):
    birth_sun = longitude(birth_jd, swe.SUN)
    low, high = birth_jd - 100, birth_jd - 75
    remaining = 48
    if hint is not None and math.isfinite(hint):
        # Only skip a prefix of this exact bisection tree. The solar arc is
        # monotone here; strict lower / inclusive upper preserve the 88° tie.
        nodes = []
        for depth in range(1, 35):
            mid = (low + high) / 2
            if mid == low or mid == high:
                break
            if hint >= mid:
                low = mid
            else:
                high = mid
            if depth >= 28:
                nodes.append((depth, low, high))
        signs = {}
        def above_target(jd):
            if jd not in signs:
                signs[jd] = (birth_sun - longitude(jd, swe.SUN)) % 360 > 88
            return signs[jd]
        valid = False
        for depth, low, high in reversed(nodes):
            try:
                valid = above_target(low) and not above_target(high)
            except ChartError:
                break
            if valid:
                remaining -= depth
                break
        if not valid:
            low, high = birth_jd - 100, birth_jd - 75
    for _ in range(remaining):
        mid = (low + high) / 2
        # Further bisections cannot change this representable midpoint.
        if mid == low or mid == high:
            break
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


class DesignTimeSearch:
    """A sample sequence owns two exact results; a prediction is never an output."""
    def __init__(self):
        self.previous = self.older = None

    def __call__(self, birth_jd):
        hint = None
        if self.previous is not None:
            old_birth, old_design = self.previous
            slope = ((old_design - self.older[1]) / (old_birth - self.older[0])
                     if self.older is not None and old_birth != self.older[0] else 1)
            hint = old_design + (birth_jd - old_birth) * slope
        result, residual = design_time(birth_jd, hint=hint)
        self.older, self.previous = self.previous, (birth_jd, result)
        return result, residual


def longitudes(jd):
    return {name: longitude(jd, body) for name, body in PLANET_BODIES}


def sample_columns(moments):
    """Exact P/D columns for an already selected UTC sample grid."""
    columns = [[] for _ in range(MOMENT_COLUMN_COUNT)]
    design_search = DesignTimeSearch()
    for moment in moments:
        jd = julian_tt(moment)
        design_jd, residual = design_search(jd)
        for side, side_jd in enumerate((jd, design_jd)):
            values = longitudes(side_jd)
            for column, (planet, _) in enumerate(PLANET_BODIES):
                columns[side * len(PLANET_BODIES) + column].append(values[planet])
        # Match API UTC seconds, including dates before 1970. Positions above
        # still use the unrounded Julian instant.
        columns[DESIGN_UNIX_SECONDS_COLUMN].append(int(tt_to_datetime(design_jd).replace(microsecond=0).timestamp()))
        columns[DESIGN_RESIDUAL_COLUMN].append(residual)
    return columns


def activations(jd):
    values = longitudes(jd)
    values['earth'] = (values['sun'] + 180) % 360
    values['south_node'] = (values['north_node'] + 180) % 360
    ordered = ['sun', 'earth', 'moon', 'north_node', 'south_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']
    result = []
    for name in ordered:
        gate, line = gate_line(values[name])
        result.append(dict(planet=name, longitude=values[name], gate=gate, line=line))
    return result
