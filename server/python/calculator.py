"""Local, deterministic chart scenario. JSON input/output; no external requests."""
import datetime as dt
import json
import sys

if __package__:
    from . import astronomy as astro
    from . import civil_time as civil
    from . import date_limits as dates
    from .errors import ChartError
else:
    import astronomy as astro
    import civil_time as civil
    import date_limits as dates
    from errors import ChartError


def calculate(request):
    mode = request.get('mode', 'natal')
    if mode == 'transit_moment':
        moment = civil.transit_utc(request.get('utc'))
        point = dict(utc=request['utc'], longitudes=list(astro.longitudes(astro.julian_tt(moment)).values()),
                     engine='Swiss Ephemeris ' + astro.swe.version)
        point['design'] = calculate(dict(mode='transit_design', utc=request['utc']))
        return point
    if mode == 'transit_design':
        moment = civil.transit_utc(request.get('utc'))
        design_jd, residual = astro.design_time(astro.julian_tt(moment))
        values = astro.longitudes(design_jd)
        return dict(utc=request['utc'], designUtc=civil.iso(astro.tt_to_datetime(design_jd)),
                    designArcResidualDegrees=residual, longitudes=list(values.values()),
                    engine='Swiss Ephemeris ' + astro.swe.version)
    city, offset, fold = None, 'UTC+00:00', 0
    if mode == 'transit':
        moment = dt.datetime.now(civil.UTC).replace(microsecond=0)
        name, date, time, place, timezone = 'Транзит', moment.strftime('%Y-%m-%d'), moment.strftime('%H:%M'), '', 'UTC'
    elif mode == 'natal':
        city = request.get('city')
        if not isinstance(city, dict) or not city.get('timezone'):
            raise ChartError('city_required', 'Выберите город из списка подсказок.')
        name = str(request.get('name', '')).strip()[:80]
        if not name:
            raise ChartError('name_required', 'Добавьте имя карты.')
        date, time, place, timezone = request.get('date'), request.get('time'), city['name'], city['timezone']
        dates.validate_natal_date(date)
        moment, offset, fold = civil.local_to_utc(date, time, timezone, request.get('fold'))
        dates.validate_natal_moment(moment)
    else:
        raise ChartError('invalid_mode', 'Неизвестный режим расчёта.')
    jd = astro.julian_tt(moment)
    personality = astro.activations(jd)
    design_jd, residual = astro.design_time(jd)
    design = astro.activations(design_jd)
    design_utc = civil.iso(astro.tt_to_datetime(design_jd))
    return {'chart': dict(
        id=None, name=name, personality=sorted(set(a['gate'] for a in personality)), design=sorted(set(a['gate'] for a in design)),
        source='transit' if mode == 'transit' else 'calculated', birthDate=date, birthTime=time, birthPlace=place, timezone=timezone,
        utc=civil.iso(moment), utcOffset=offset, fold=fold, designUtc=design_utc, cityId=city['id'] if city else None, city=city,
        activations=dict(personality=personality, design=design), engine='Swiss Ephemeris ' + astro.swe.version, ephemeris='Swiss files: sepl_18.se1 + semo_18.se1',
        timezoneDatabase='IANA tzdata ' + civil.tzdata.__version__, nodeModel='true', zodiac='tropical-geocentric-apparent',
        designArcResidualDegrees=residual, updatedAt=civil.iso(dt.datetime.now(civil.UTC)), createdAt=civil.iso(dt.datetime.now(civil.UTC)), note='',
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
