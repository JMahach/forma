"""Pinned civil-time rules: UTC conversion, folds, gaps and local minute grids."""
import datetime as dt
import re
import zoneinfo
import tzdata

if __package__:
    from .errors import ChartError
else:
    from errors import ChartError

# Use the pinned package, not whichever database the operating system has.
zoneinfo.reset_tzpath([])
UTC = dt.timezone.utc


def iso(moment):
    return moment.astimezone(UTC).isoformat(timespec='seconds').replace('+00:00', 'Z')


def offset_label(delta):
    seconds = int(delta.total_seconds())
    sign = '+' if seconds >= 0 else '−'
    hours, rest = divmod(abs(seconds), 3600)
    minutes, seconds = divmod(rest, 60)
    return f'UTC{sign}{hours:02d}:{minutes:02d}' + (f':{seconds:02d}' if seconds else '')


def transit_utc(value):
    """Public transit instants use canonical UTC seconds or milliseconds."""
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z', value):
        raise ChartError('invalid_utc', 'Нужен точный момент UTC.')
    try:
        moment = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ChartError('invalid_utc', 'Некорректный момент UTC.')
    if not 1801 <= moment.year <= 2399:
        raise ChartError('unsupported_date', 'Доступны даты с 1801 по 2399 год.')
    return moment


def _local_candidates(local, zone):
    candidates = []
    for candidate_fold in (0, 1):
        aware = local.replace(tzinfo=zone, fold=candidate_fold)
        utc = aware.astimezone(UTC)
        if utc.astimezone(zone).replace(tzinfo=None) == local and all(existing[1] != utc for existing in candidates):
            candidates.append((candidate_fold, utc, aware.utcoffset()))
    return candidates


def local_to_utc(date, time, timezone, fold=None):
    try:
        local = dt.datetime.strptime(f'{date} {time}', '%Y-%m-%d %H:%M')
        zone = zoneinfo.ZoneInfo(timezone)
    except (ValueError, TypeError, zoneinfo.ZoneInfoNotFoundError):
        raise ChartError('invalid_datetime', 'Проверьте дату, время и выбранный город.')
    if not 1801 <= local.year <= 2399:
        raise ChartError('unsupported_date', 'Доступны даты с 1801 по 2399 год.')
    candidates = _local_candidates(local, zone)
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


def local_minutes(date, timezone):
    if not isinstance(date, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):
        raise ChartError('invalid_date', 'Нужна дата рождения в формате YYYY-MM-DD.')
    try:
        day = dt.date.fromisoformat(date)
    except ValueError:
        raise ChartError('invalid_date', 'Некорректная дата рождения.')
    if not 1801 <= day.year <= 2399:
        raise ChartError('unsupported_date', 'Доступны даты с 1801 по 2399 год.')
    try:
        zone = zoneinfo.ZoneInfo(timezone)
    except (ValueError, TypeError, zoneinfo.ZoneInfoNotFoundError):
        raise ChartError('invalid_timezone', 'Неизвестный часовой пояс города.')
    # Enumerating wall-clock minute labels avoids assuming midnight exists or
    # that historical UTC offsets are whole minutes. Both folds are retained.
    beginning = dt.datetime.combine(day, dt.time())
    unique = {}
    for minute in range(1440):
        local = beginning + dt.timedelta(minutes=minute)
        for fold, moment, offset in _local_candidates(local, zone):
            unique[moment] = (moment, offset_label(offset), fold, int(offset.total_seconds()))
    if not unique:
        raise ChartError('nonexistent_date', 'Этот местный день был пропущен при смене часового пояса.')
    return [unique[moment] for moment in sorted(unique)]
