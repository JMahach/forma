"""Exact return roots and an explicitly prepared, read-only trajectory index.

The index supplies winding numbers and monotone brackets, never interpolated
answers. Every returned root is checked with the current Swiss Ephemeris files.
Run this module to prepare the shared file, or pass --check to verify it.
"""
import argparse
import array
import bisect
import datetime as dt
import hashlib
import json
import math
import mmap
import os
import pathlib
import struct
import sys
import tempfile

if __package__:
    from . import astronomy as astro, date_limits as dates
    from .errors import ChartError
else:
    import astronomy as astro
    import date_limits as dates
    from errors import ChartError

YEAR_DAYS = 365.2425
SECOND_DAYS = 1 / 86400
ANGLE_TOLERANCE = 1e-8
ROOT_TOLERANCE = 1e-7
# Swiss true-node speeds have numerical noise near zero. This labels only an
# already isolated speed root, never an arbitrary slow sample or longitude root.
STATION_SPEED_TOLERANCE = 1e-7
BODIES = {
    'sun': (astro.swe.SUN, 8, 1, 0, 'Соляр'),
    'moon': (astro.swe.MOON, 1, 1, 0, 'Лунар'),
    'north_node': (astro.swe.TRUE_NODE, .125, -1, 0, 'Возврат лунных узлов'),
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
PHYSICAL_BODIES = tuple(body for body in BODIES if body not in ('sun', 'moon', 'uranus_opposition'))
DEFAULT_FILE = astro.ROOT / '.cache' / 'returns' / 'return-index.bin'
MAGIC = b'FRMRET01'
SCHEMA = 1
PREFIX = struct.Struct('<8sI32s')


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
    """Safeguarded interpolation: retain a sign bracket down to adjacent floats."""
    a, b = left, right
    fa, fb = function(a), function(b)
    if fa == 0:
        return a
    if fb == 0:
        return b
    if fa * fb > 0:
        raise ChartError('cycle_search_failed', 'Не удалось уточнить точный момент возврата.')
    if abs(fa) < abs(fb):
        a, b, fa, fb = b, a, fb, fa
    c, fc, d, bisected = a, fa, a, True
    for _ in range(100):
        low, high = sorted((a, b))
        if math.nextafter(low, high) >= high:
            return a if abs(fa) < abs(fb) else b
        if fa != fc and fb != fc:
            s = b + (a-b)*fb*fc/((fa-fb)*(fa-fc)) + (c-b)*fa*fb/((fc-fa)*(fc-fb))
        else:
            s = b - fb*(b-a)/(fb-fa)
        inner_low, inner_high = sorted(((3*a+b)/4, b))
        if (not inner_low < s < inner_high
                or bisected and abs(s-b) >= abs(b-c)/2
                or not bisected and abs(s-b) >= abs(c-d)/2
                or bisected and abs(b-c) <= math.ulp(b)
                or not bisected and abs(c-d) <= math.ulp(b)):
            s, bisected = (a+b)/2, True
        else:
            bisected = False
        if s == a or s == b:
            s = math.nextafter(b, a)
        fs = function(s)
        if fs == 0:
            return s
        d, c, fc = c, b, fb
        if fa * fs < 0:
            b, fb = s, fs
        else:
            a, fa = s, fs
        if abs(fa) < abs(fb):
            a, b, fa, fb = b, a, fb, fa
    raise ChartError('cycle_search_failed', 'Не удалось уточнить точный момент возврата.')


class Trajectory:
    """Read-only samples, monotone-run boundaries and explicit station ownership."""
    def __init__(self, times, phases, boundaries, stations=(), gaps=()):
        self.times, self.phases = times, phases
        self.boundaries, self.stations, self.gaps = boundaries, stations, gaps

    @classmethod
    def build(cls, sample, start, end, step, retain_step=None, cuts=()):
        if not start < end or step <= 0:
            raise ValueError('Invalid trajectory range')
        times, phases = array.array('d'), array.array('d')
        stations, gaps = [], []
        longitude, speed = sample(start)
        phase = longitude
        previous = (start, longitude, speed)
        times.append(start); phases.append(phase)
        next_retained = start + (retain_step or step/2)
        gap_left = {left for left, right in cuts}
        # Swiss derives node speed from lunar positions +/- 0.0001 day.
        # Preserve these neighborhoods as well as both sides of every gap.
        landmarks = sorted({stamp for left, right in cuts
            for stamp in (left-.0001, left, right, right+.0001) if start < stamp < end})
        landmark = 0

        def append(stamp, value, station=False):
            if times[-1] == stamp:
                if station and (not stations or stations[-1] != len(times)-1):
                    stations.append(len(times)-1)
                return
            times.append(stamp); phases.append(value)
            if station:
                stations.append(len(times)-1)

        def endpoints(stamp):
            nonlocal landmark
            while landmark < len(landmarks) and landmarks[landmark] <= stamp:
                point = landmarks[landmark]
                landmark += 1
                yield point, True
            if previous[0] < stamp:
                yield stamp, False

        left = start
        while left < end:
            right = min(end, left+step)
            for grid in ((left+right)/2, right):
                for stamp, forced in endpoints(grid):
                    lon, velocity = sample(stamp)
                    prev_t, prev_lon, prev_speed = previous
                    gap = prev_t in gap_left
                    if gap:
                        append(prev_t, phase)
                        gaps.append(len(times)-1)
                    elif prev_speed*velocity < 0:
                        root = bisect_root(lambda jd: sample(jd)[1], prev_t, stamp)
                        root_lon, root_speed = sample(root)
                        phase += angle_delta(root_lon, prev_lon)
                        append(root, phase, abs(root_speed) <= STATION_SPEED_TOLERANCE)
                        prev_lon = root_lon
                    phase += angle_delta(lon, prev_lon)
                    keep = (retain_step is None or stamp >= next_retained or stamp == end
                            or velocity == 0 or gap or forced)
                    if keep:
                        append(stamp, phase, velocity == 0 and not gap)
                        while next_retained <= stamp:
                            next_retained += retain_step or step/2
                    previous = (stamp, lon, velocity)
            left = right
        boundaries = [0]
        last_sign = 0
        for index in range(1, len(phases)):
            delta = phases[index]-phases[index-1]
            sign = 1 if delta > 0 else -1 if delta < 0 else 0
            if sign and last_sign and sign != last_sign:
                boundaries.append(index-1)
            if sign:
                last_sign = sign
        if boundaries[-1] != len(times)-1:
            boundaries.append(len(times)-1)
        boundaries = sorted(set(boundaries).union(gaps, (index+1 for index in gaps)))
        return cls(times, phases, array.array('I', boundaries), array.array('I', stations), array.array('I', gaps))

    def phase_at(self, stamp, longitude):
        """Recover exact winding from one stored bracket and current longitude."""
        if not self.times[0] <= stamp <= self.times[-1]:
            raise ValueError('Trajectory does not cover the moment')
        at = bisect.bisect_right(self.times, stamp)-1
        return self.phases[at] + angle_delta(longitude, self.phases[at] % 360)

    def search(self, sample, start, end, direction=1, offset=0):
        if not self.times[0] <= start < end <= self.times[-1]:
            raise ValueError('Trajectory does not cover requested interval')
        origin = sample(start)[0]
        target_angle = (origin + direction*offset) % 360
        at = bisect.bisect_right(self.times, start)-1
        birth_phase = self.phase_at(start, origin)
        roots = []
        # Only overlapping runs are visited; a cold mmap need not decode the
        # whole index or allocate Python objects for every stored sample.
        first_run = max(0, bisect.bisect_right(self.boundaries, at)-1)
        for run in range(first_run, len(self.boundaries)-1):
            lo, hi = self.boundaries[run], self.boundaries[run+1]
            if self.times[lo] > end:
                break
            gap = bisect.bisect_left(self.gaps,lo)
            if gap < len(self.gaps) and self.gaps[gap] == lo and hi == lo+1:
                continue
            p0, p1 = self.phases[lo], self.phases[hi]
            sign = 1 if p1 >= p0 else -1
            q0, q1 = direction*(p0-birth_phase), direction*(p1-birth_phase)
            low, high = sorted((q0, q1))
            first = max(0 if offset else 1, math.ceil((low-offset-ANGLE_TOLERANCE)/360))
            last = math.floor((high-offset+ANGLE_TOLERANCE)/360)
            turns = range(first, last+1) if q1 >= q0 else range(last, first-1, -1)
            for turn in turns:
                target = birth_phase + direction*(turn*360+offset)
                l, r = lo, hi
                while r-l > 1:
                    middle = (l+r)//2
                    if sign*self.phases[middle] < sign*target:
                        l = middle
                    else:
                        r = middle
                # Phases choose a bracket only. All residuals use the exact
                # natal longitude, never target % 360 from an accumulated sum.
                def residual(jd):
                    return angle_delta(sample(jd)[0], target_angle)
                a, b = self.times[l], self.times[r]
                fa, fb = residual(a), residual(b)
                if fa*fb > 0 and lo < l and abs(self.phases[l]-target) < ANGLE_TOLERANCE:
                    l -= 1; a = self.times[l]; fa = residual(a)
                if fa*fb > 0 and r < hi and abs(self.phases[r]-target) < ANGLE_TOLERANCE:
                    r += 1; b = self.times[r]; fb = residual(b)
                station = False
                if fa*fb < 0:
                    root = bisect_root(residual, a, b)
                elif fa == 0:
                    root = a; station = self._station(l)
                elif fb == 0:
                    root = b; station = self._station(r)
                elif self._station(l) and abs(fa) <= ANGLE_TOLERANCE:
                    root, station = a, True
                elif self._station(r) and abs(fb) <= ANGLE_TOLERANCE:
                    root, station = b, True
                else:
                    continue
                if root <= start+SECOND_DAYS or root > end:
                    continue
                if abs(residual(root)) > ROOT_TOLERANCE:
                    raise ChartError('cycle_search_failed', 'Невязка точного возврата превышает допустимую.')
                if roots and abs(root-roots[-1]['jd']) <= max(math.ulp(root)*2, 1e-12):
                    if station:
                        roots[-1]['direction'] = 'stationary'
                    continue
                roots.append(dict(jd=root, cycle=turn+(1 if offset else 0),
                    direction='stationary' if station else 'direct' if sign > 0 else 'retrograde'))
        return roots

    def _station(self, index):
        at = bisect.bisect_left(self.stations, index)
        return at < len(self.stations) and self.stations[at] == index


def scan_crossings(sample, start, end, step, direction=1, offset=0):
    return Trajectory.build(sample, start, end, step).search(sample, start, end, direction, offset)


def lunar_file_segments(path):
    """Read the documented Swiss v3 single-Moon file header, not its coefficients."""
    with pathlib.Path(path).open('rb') as source:
        if source.readline(80).split() != [b'SWISSEPH', b'3']:
            raise ValueError('Unsupported Swiss lunar file version')
        for _ in range(2):
            if not source.readline(256).endswith(b'\r\n'):
                raise ValueError('Invalid Swiss lunar file header')
        marker = source.read(4)
        order = '<' if marker == b'cba\0' else '>' if marker == b'\0abc' else None
        if order is None:
            raise ValueError('Invalid Swiss byte order marker')
        size, _, file_start, file_end, count = struct.unpack(order+'II2dH', source.read(26))
        if size != os.fstat(source.fileno()).st_size or count != 1:
            raise ValueError('Invalid single-Moon file size or body count')
        if struct.unpack(order+'H', source.read(2))[0] != 1:
            raise ValueError('Lunar file does not contain the Swiss Moon')
        source.seek(4+5*8+10, 1)  # CRC, general constants, lunar record prefix.
        start, end, step = struct.unpack(order+'3d', source.read(24))
        if not (all(math.isfinite(value) for value in (start, end, step))
                and start == file_start and end == file_end and start < end and 0 < step < end-start):
            raise ValueError('Invalid lunar segment coverage')
        return start, end, step


def lunar_segment_cuts(start, end):
    """Isolate adjacent JD values on either side of every apparent-node gap.

    Swiss sweph.c/read_const stores the lunar segment epoch and duration;
    lunar_osc_elem evaluates each segment at t minus lunar light-time. Reading
    these boundaries avoids relying on a sampling heuristic to detect a jump.
    """
    position(start, 'north_node')
    path, _, _, _ = astro.swe.get_current_file_data(1)
    try:
        first, last, step = lunar_file_segments(path)
    except (OSError, ValueError, struct.error) as error:
        raise ChartError('ephemeris_unavailable', 'Не удалось прочитать границы точных лунных эфемерид.') from error
    if not first <= start < end <= last:
        raise ChartError('ephemeris_unavailable', 'Лунные эфемериды не покрывают выбранный интервал.')
    cuts = []
    for number in range(max(1, math.floor((start-first)/step)), math.ceil((end-first)/step)+1):
        raw = first+number*step
        if raw > end:
            break
        apparent = raw
        for _ in range(3):
            values, used = astro.swe.calc(apparent, astro.swe.MOON, astro.FLAGS | astro.swe.FLG_TRUEPOS)
            if not used & astro.swe.FLG_SWIEPH or used & astro.swe.FLG_MOSEPH:
                raise ChartError('ephemeris_unavailable', 'Точные лунные эфемериды недоступны.')
            apparent = raw + values[2]*149597870700/299792458/86400
        # Public spherical distance and the internal Cartesian norm can round
        # the light-time boundary to neighboring floats. Inspect that tiny
        # neighborhood explicitly, and retain the boundary even for tiny gaps.
        unit = math.ulp(apparent)
        left = apparent-8*unit
        previous = position(left, 'north_node')[0]
        largest, cut = -1, None
        for index in range(1, 17):
            right = apparent+(index-8)*unit
            current = position(right, 'north_node')[0]
            difference = abs(angle_delta(current, previous))
            if difference > largest:
                largest, cut = difference, (left, right)
            left, previous = right, current
        if start <= cut[0] < cut[1] <= end:
            cuts.append(cut)
    return cuts


def prepare_trajectory(body, start, end):
    cuts = lunar_segment_cuts(start, end) if body == 'north_node' else ()
    return Trajectory.build(lambda jd: position(jd, body), start, end, BODIES[body][1],
                            retain_step=.5 if body == 'north_node' else None, cuts=cuts)


def _strict_native_root(candidate, target, body, start, end):
    if abs(angle_delta(position(candidate, body)[0], target)) <= ROOT_TOLERANCE:
        return candidate
    radius = SECOND_DAYS
    for _ in range(9):
        left, right = max(start, candidate-radius), min(end, candidate+radius)
        function = lambda jd: angle_delta(position(jd, body)[0], target)
        if function(left) <= 0 <= function(right):
            root = bisect_root(function, left, right)
            if abs(function(root)) <= ROOT_TOLERANCE:
                return root
            break
        radius *= 2
    raise ChartError('cycle_search_failed', 'Невязка точного возврата превышает допустимую.')


def native_crossings(body, start, end):
    if body not in ('sun', 'moon'):
        raise ValueError('No geocentric native crossing API for this body')
    target = position(start, body)[0]
    position(end, body)
    next_crossing = astro.swe.solcross if body == 'sun' else astro.swe.mooncross
    coverage_end = astro.julian_tt(dates.SUPPORTED_END_EXCLUSIVE)
    horizon = 400 if body == 'sun' else 32
    cursor, roots = start+SECOND_DAYS, []
    while cursor < end:
        if cursor+horizon >= coverage_end:
            offset = (target-position(cursor, body)[0]) % 360
            tail = scan_crossings(lambda jd: position(jd, body), cursor, end, BODIES[body][1], offset=offset)
            for entry in tail:
                root = _strict_native_root(entry['jd'], target, body, cursor, end)
                roots.append(dict(jd=root, cycle=len(roots)+1, direction='direct'))
            break
        try:
            candidate = next_crossing(target, cursor, astro.FLAGS)
        except astro.swe.Error:
            raise ChartError('ephemeris_unavailable', 'Точные эфемериды недоступны.', body=body)
        if not math.isfinite(candidate) or candidate < cursor:
            raise ChartError('cycle_search_failed', 'Не удалось найти следующий возврат.')
        if candidate > end:
            break
        root = _strict_native_root(candidate, target, body, cursor, end)
        if not cursor <= root <= end or position(root, body)[1] <= 0:
            raise ChartError('cycle_search_failed', 'Некорректный следующий возврат.')
        roots.append(dict(jd=root, cycle=len(roots)+1, direction='direct'))
        cursor = root+SECOND_DAYS
    return roots


class InvalidIndex(ValueError):
    pass


def provenance():
    digest = hashlib.sha256()
    names = ['server/python/return_index.py', 'server/python/astronomy.py', 'server/python/civil_time.py',
             'server/python/date_limits.py', 'server/python/errors.py', 'shared/date-limits.js', 'requirements.txt']
    names += [str(file.relative_to(astro.ROOT)) for file in sorted((astro.ROOT/'data'/'ephe').glob('*')) if file.is_file()]
    digest.update(f'{astro.swe.version}\0{astro.FLAGS}\0{SCHEMA}\0'.encode())
    for name in names:
        data = (astro.ROOT/name).read_bytes()
        digest.update(f'{name}\0{len(data)}\0'.encode()); digest.update(data)
    return digest.hexdigest()


class _ArrayView:
    def __init__(self, data, offset, count, code):
        self.data, self.offset, self.count = data, offset, count
        self.item = struct.Struct('<'+code)
    def __len__(self):
        return self.count
    def __getitem__(self, index):
        if index < 0:
            index += self.count
        if not 0 <= index < self.count:
            raise IndexError(index)
        return self.item.unpack_from(self.data, self.offset+index*self.item.size)[0]


class PreparedIndex:
    def __init__(self, data, header, base):
        self.data, self.header, self.base = data, header, base
    def close(self):
        self.data.close()
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.close()
    def trajectory(self, body):
        body = 'uranus' if body == 'uranus_opposition' else body
        entry = self.header['bodies'].get(body)
        if entry is None:
            raise InvalidIndex('Requested body is absent')
        arrays = []
        for name, code in (('times','d'),('phases','d'),('boundaries','I'),('stations','I'),('gaps','I')):
            section = entry[name]
            arrays.append(_ArrayView(self.data, self.base+section['offset'], section['count'], code))
        return Trajectory(*arrays)


def load_index(path=DEFAULT_FILE, expected_provenance=None, full=False):
    with open(path, 'rb') as file:
        if os.fstat(file.fileno()).st_size < PREFIX.size:
            raise InvalidIndex('Truncated index')
        data = mmap.mmap(file.fileno(), 0, access=mmap.ACCESS_READ)
    try:
        magic, size, checksum = PREFIX.unpack_from(data)
        if magic != MAGIC or not 0 < size <= 1_000_000 or PREFIX.size+size > len(data):
            raise InvalidIndex('Invalid index header')
        encoded = data[PREFIX.size:PREFIX.size+size]
        if hashlib.sha256(encoded).digest() != checksum:
            raise InvalidIndex('Index header checksum mismatch')
        header = json.loads(encoded)
        base = PREFIX.size+size
        if header['schema'] != SCHEMA or header['provenance'] != (expected_provenance or provenance()):
            raise InvalidIndex('Index calculation version changed')
        if header['payloadBytes'] != len(data)-base or not header['start'] < header['end']:
            raise InvalidIndex('Invalid index coverage/size')
        view = memoryview(data)[base:]
        checksum = hashlib.sha256(view).hexdigest()
        view.release()
        if checksum != header['sha256']:
            raise InvalidIndex('Index payload checksum mismatch')
        offset = 0
        if not header['bodies'] or any(body not in PHYSICAL_BODIES for body in header['bodies']):
            raise InvalidIndex('Invalid physical bodies')
        for entry in header['bodies'].values():
            if entry['times']['count'] < 2 or entry['times']['count'] != entry['phases']['count'] or entry['boundaries']['count'] < 2:
                raise InvalidIndex('Invalid trajectory counts')
            for name, width in (('times',8),('phases',8),('boundaries',4),('stations',4),('gaps',4)):
                section = entry[name]
                if type(section['count']) is not int or section['count'] < 0 or section['offset'] != offset:
                    raise InvalidIndex('Invalid trajectory section')
                offset += section['count']*width
        if offset != header['payloadBytes']:
            raise InvalidIndex('Invalid trajectory layout')
        index = PreparedIndex(data, header, base)
        for body in header['bodies']:
            curve = index.trajectory(body)
            if curve.times[0] != header['start'] or curve.times[-1] != header['end'] or curve.boundaries[0] != 0 or curve.boundaries[-1] != len(curve.times)-1:
                raise InvalidIndex('Invalid trajectory bounds')
            if full:
                validate_trajectory(curve)
        return index
    except (KeyError, TypeError, json.JSONDecodeError, struct.error, IndexError) as error:
        data.close(); raise InvalidIndex('Invalid index structure') from error
    except BaseException:
        data.close(); raise


def validate_trajectory(curve):
    previous = -math.inf
    for index in range(len(curve.times)):
        stamp, phase = curve.times[index], curve.phases[index]
        if not math.isfinite(stamp) or not math.isfinite(phase) or stamp <= previous:
            raise InvalidIndex('Non-finite or unordered trajectory')
        previous = stamp
    for boundaries in (curve.boundaries, curve.stations, curve.gaps):
        previous = -1
        for item in boundaries:
            if not previous < item < len(curve.times):
                raise InvalidIndex('Invalid boundary index')
            previous = item
    for run in range(len(curve.boundaries)-1):
        low, high = curve.boundaries[run], curve.boundaries[run+1]
        gap = bisect.bisect_left(curve.gaps,low)
        if gap < len(curve.gaps) and curve.gaps[gap] == low:
            if high != low+1:
                raise InvalidIndex('Unsplit trajectory gap')
            continue
        sign = 1 if curve.phases[high] >= curve.phases[low] else -1
        for index in range(low+1, high+1):
            if sign*(curve.phases[index]-curve.phases[index-1]) < 0:
                raise InvalidIndex('Non-monotone trajectory run')


def prepare_index(path=DEFAULT_FILE, *, start=None, end=None, bodies=PHYSICAL_BODIES):
    path = pathlib.Path(path)
    start = astro.julian_tt(dates.SUPPORTED_START) if start is None else start
    end = math.nextafter(astro.julian_tt(dates.SUPPORTED_END_EXCLUSIVE), -math.inf) if end is None else end
    if not math.isfinite(start) or not math.isfinite(end) or not start < end or not bodies or len(set(bodies)) != len(bodies) or any(body not in PHYSICAL_BODIES for body in bodies):
        raise ValueError('Invalid preparation request')
    fingerprint = provenance()
    try:
        with load_index(path, fingerprint) as existing:
            if existing.header['start'] == start and existing.header['end'] == end and tuple(existing.header['bodies']) == tuple(bodies):
                return dict(existing.header, reused=True)
    except (OSError, InvalidIndex):
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name+'.', suffix='.tmp', dir=path.parent)
    try:
        # Payload is prepared separately so the final file has one small header
        # followed by contiguous mmap arrays. Only explicit preparation writes.
        payload = tempfile.TemporaryFile(dir=path.parent)
        with payload:
            entries, offset = {}, 0
            digest = hashlib.sha256()
            for body in bodies:
                curve = prepare_trajectory(body, start, end)
                validate_trajectory(curve)
                entry = {}
                for name, code in (('times','d'),('phases','d'),('boundaries','I'),('stations','I'),('gaps','I')):
                    values = array.array(code, getattr(curve, name))
                    if sys.byteorder != 'little':
                        values.byteswap()
                    encoded = values.tobytes()
                    entry[name] = dict(offset=offset, count=len(values))
                    payload.write(encoded); digest.update(encoded); offset += len(encoded)
                entries[body] = entry
            header = dict(schema=SCHEMA, provenance=fingerprint, start=start, end=end,
                          bodies=entries, payloadBytes=offset, sha256=digest.hexdigest())
            encoded = json.dumps(header, separators=(',',':'), allow_nan=False).encode()
            with os.fdopen(descriptor, 'wb') as output:
                descriptor = None
                os.fchmod(output.fileno(),0o644)
                output.write(PREFIX.pack(MAGIC, len(encoded), hashlib.sha256(encoded).digest()))
                output.write(encoded); payload.seek(0)
                while chunk := payload.read(1024*1024):
                    output.write(chunk)
                output.flush(); os.fsync(output.fileno())
        os.replace(temporary, path)
        return dict(header, reused=False)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def find_crossings(body, start, end, index_path=DEFAULT_FILE):
    if body in ('sun', 'moon'):
        return native_crossings(body, start, end)
    physical = 'uranus' if body == 'uranus_opposition' else body
    direction, offset = BODIES[body][2:4]
    try:
        index = load_index(index_path)
    except (OSError, InvalidIndex):
        index = None
    if index is not None:
        with index:
            if physical in index.header['bodies'] and index.header['start'] <= start < end <= index.header['end']:
                return index.trajectory(physical).search(lambda jd: position(jd, physical), start, end, direction, offset)
    return prepare_trajectory(physical, start, end).search(lambda jd: position(jd, physical), start, end, direction, offset)


def has_completed_return(body, start, end, origin, longitude):
    """Prove a full turn (half a turn for opposition), without finding events."""
    if end <= start+SECOND_DAYS:
        return False
    if body in ('sun', 'moon'):
        # These longitudes are monotone. The first crossing proves all later
        # returns; only one orbital period is inspected, even for an old event.
        horizon = 400 if body == 'sun' else 32
        coverage_end = math.nextafter(astro.julian_tt(dates.SUPPORTED_END_EXCLUSIVE), -math.inf)
        limit = min(end+4*math.ulp(end), start+horizon, coverage_end)
        return bool(native_crossings(body, start, limit))
    try:
        with load_index(DEFAULT_FILE) as index:
            if not index.header['start'] <= start < end <= index.header['end']:
                raise InvalidIndex('Index does not cover the requested moments')
            curve = index.trajectory(body)
            phase_delta = curve.phase_at(end, longitude)-curve.phase_at(start, origin)
    except (OSError, InvalidIndex) as error:
        # A matching angle alone also accepts early retrograde recrossings.
        # With no trusted winding data, fail closed rather than scan a life.
        raise ChartError('return_index_unavailable',
            'Не удалось проверить полный оборот: подготовленный индекс возвратов недоступен.') from error
    direction, offset = BODIES[body][2:4]
    return direction*phase_delta >= (offset or 360)-ROOT_TOLERANCE


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file', type=pathlib.Path, default=DEFAULT_FILE)
    parser.add_argument('--check', action='store_true', help='verify the complete existing file without writing')
    arguments = parser.parse_args()
    try:
        if arguments.check:
            with load_index(arguments.file, full=True) as index:
                result = dict(index.header, verified=True)
        else:
            result = prepare_index(arguments.file)
        print(json.dumps(dict(file=str(arguments.file), **result), ensure_ascii=False))
    except (OSError, ValueError, ChartError) as error:
        print(json.dumps(dict(error='return_index_unavailable', message=str(error)), ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
