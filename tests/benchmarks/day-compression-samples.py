"""Real minute-grid inputs for the isolated lossless compression experiment.

No API, library, ephemeris algorithm or live-transit behavior is changed.
The generator uses the current calculator at each actual minute of a local day.
"""
import argparse
import datetime as dt
import json
import pathlib
import sys
import time
import zoneinfo

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from server import calculator as calc


def generate(date, timezone):
    day = dt.date.fromisoformat(date)
    zone = zoneinfo.ZoneInfo(timezone)
    start = dt.datetime.combine(day, dt.time(), zone).astimezone(calc.UTC)
    end = dt.datetime.combine(day + dt.timedelta(days=1), dt.time(), zone).astimezone(calc.UTC)
    # Benchmark fixtures deliberately have real, unambiguous local midnights.
    assert start.astimezone(zone).date() == day
    assert end.astimezone(zone).date() == day + dt.timedelta(days=1)
    count = int((end - start).total_seconds() // 60)
    assert count in (1380, 1410, 1440, 1470, 1500)
    city = dict(id='benchmark', name='Synthetic benchmark', timezone=timezone)
    generated_at = calc.iso(dt.datetime.now(calc.UTC))
    natal, transit = [], []
    natal_seconds = transit_seconds = 0
    for minute in range(count):
        moment = start + dt.timedelta(minutes=minute)
        local = moment.astimezone(zone)
        before = time.perf_counter()
        chart = calc.calculate(dict(mode='natal', name='Benchmark', date=date,
                                    time=local.strftime('%H:%M'), city=city, fold=local.fold))['chart']
        natal_seconds += time.perf_counter() - before
        assert chart['utc'] == calc.iso(moment)
        # These are package creation timestamps, not independent astronomical data.
        chart['createdAt'] = chart['updatedAt'] = generated_at
        natal.append(chart)
        before = time.perf_counter()
        values = calc.activations(calc.julian_tt(moment))
        transit_seconds += time.perf_counter() - before
        transit.append(dict(utc=calc.iso(moment), activations=dict(personality=values, design=[])))
    return dict(date=date, timezone=timezone, startUtc=calc.iso(start), stepSeconds=60,
                samples=count, natalCalculationMs=natal_seconds * 1000,
                transitCalculationMs=transit_seconds * 1000, natal=natal, transit=transit)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('date')
    parser.add_argument('timezone')
    args = parser.parse_args()
    print(json.dumps(generate(args.date, args.timezone), ensure_ascii=False, separators=(',', ':')))
