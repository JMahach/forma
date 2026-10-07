"""Prepare an exact planetary lifetime file; never run in the HTTP request path.

Example: python -m server.python.lifetime_file --file /path/all.f64le
The shared browser/server format is also the preparation tool's source of truth.
"""
import argparse
import array
import ast
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
import datetime as dt
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import re
import sys
import tempfile
import time

if __package__:
    from . import astronomy as astro
else:
    import astronomy as astro

ROOT = Path(__file__).resolve().parents[2]
UTC = dt.timezone.utc
MIN_DATE, MAX_DATE = dt.date(1801, 1, 1), dt.date(2400, 1, 1)
CHUNK_DAYS = 7


def shared_literal(name, file='shared/lifetime-format.js'):
    """Read only literal declarations, without evaluating JavaScript or Node."""
    source = (ROOT / file).read_text()
    match = re.search(r'export const ' + re.escape(name) + r' = (.+);', source)
    if not match:
        raise ValueError('Missing shared lifetime format constant: ' + name)
    value = match.group(1)
    if value.startswith('Object.freeze(') and value.endswith(')'):
        value = value[len('Object.freeze('):-1]
    return ast.literal_eval(value)


def calculation_fingerprint():
    digest = hashlib.sha256()
    def add(name):
        file = ROOT / name
        if file.is_dir():
            for child in sorted(file.iterdir(), key=lambda entry: entry.name.encode('utf-8')):
                add(f'{name}/{child.name}')
        else:
            payload = file.read_bytes()
            digest.update(f'{name}\0{len(payload)}\0'.encode('utf-8'))
            digest.update(payload)
    for name in shared_literal('LIFETIME_PROVENANCE_INPUTS'):
        add(name)
    return digest.hexdigest()


def lifetime_format():
    planets = shared_literal('MOMENT_PLANETS', 'shared/day-packets/moment-columns.js')
    step = shared_literal('LIFETIME_STEP_SECONDS')
    if not isinstance(planets, list) or not planets or len(set(planets)) != len(planets):
        raise ValueError('Invalid shared planet order')
    if planets != [name for name, _ in astro.PLANET_BODIES]:
        raise ValueError('Shared planets differ from the calculation contract')
    if not isinstance(step, int) or step < 1 or 86400 % step:
        raise ValueError('Invalid shared sample interval')
    return planets, step, shared_literal('LIFETIME_FILE_VERSION'), shared_literal('LIFETIME_FILE_FORMAT')


def interval(start, end):
    first, last = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    if first.isoformat() != start or last.isoformat() != end or not MIN_DATE <= first < last <= MAX_DATE:
        raise ValueError('Lifetime file interval must be within 1801-01-01 through 2400-01-01 exclusive')
    return dt.datetime.combine(first, dt.time(), UTC), dt.datetime.combine(last, dt.time(), UTC)


def boundary_check(start, end, step):
    moments = (start, end - dt.timedelta(seconds=step))
    columns = astro.sample_columns(moments)
    return [dict(utc=moment.isoformat().replace('+00:00', 'Z'),
                 values=[column[index] for column in columns])
            for index, moment in enumerate(moments)]


def calculate_chunk(start_iso, offset, count, step):
    start = dt.datetime.fromisoformat(start_iso)
    moments = (start + dt.timedelta(seconds=index * step) for index in range(offset, offset + count))
    columns = astro.sample_columns(moments)
    rows = array.array('d', (value for row in zip(*columns) for value in row))
    if rows.itemsize != 8:
        raise RuntimeError('Float64 arrays are required')
    if sys.byteorder != 'little':
        rows.byteswap()
    return offset, rows.tobytes()


def publish_new(temporary, destination):
    # A same-filesystem hard link publishes complete bytes atomically AND fails
    # if the destination already exists. Unlike os.replace it cannot overwrite
    # a completed lifetime file from a concurrent preparation run.
    os.link(temporary, destination)
    os.unlink(temporary)


def generate_lifetime_file(file, start='1801-01-01', end='2400-01-01', workers=3, progress=None):
    destination = Path(file)
    if destination.suffix != '.f64le':
        raise ValueError('Lifetime file must end in .f64le')
    metadata_file = destination.with_suffix('.metadata.json')
    if destination.exists() or metadata_file.exists():
        raise FileExistsError('Refusing to overwrite an existing lifetime file or metadata file')
    if not isinstance(workers, int) or not 1 <= workers <= 8:
        raise ValueError('Use between one and eight preparation workers')
    first, last = interval(start, end)
    planets, step, version, format_text = lifetime_format()
    provenance = dict(version='1', calculationFingerprint=calculation_fingerprint())
    boundary = boundary_check(first, last, step)
    samples = int((last - first).total_seconds()) // step
    chunk_samples = CHUNK_DAYS * 86400 // step
    byte_count = samples * astro.MOMENT_COLUMN_COUNT * 8
    destination.parent.mkdir(parents=True, exist_ok=True)
    began = time.perf_counter()
    data_fd, temporary = tempfile.mkstemp(prefix=destination.name + '.', suffix='.tmp', dir=destination.parent)
    metadata_temporary = None
    completed = 0
    def report():
        if progress:
            progress(dict(completedSamples=completed, totalSamples=samples,
                          completedYears=round(completed * step / (365.2425 * 86400), 2),
                          elapsedSeconds=round(time.perf_counter() - began, 3)))
    try:
        with os.fdopen(data_fd, 'w+b') as stream:
            stream.truncate(byte_count)
            def save(result):
                nonlocal completed
                offset, payload = result
                count = len(payload) // (astro.MOMENT_COLUMN_COUNT * 8)
                stream.seek(offset * astro.MOMENT_COLUMN_COUNT * 8)
                stream.write(payload)
                completed += count
                report()
            chunks = iter((offset, min(chunk_samples, samples - offset)) for offset in range(0, samples, chunk_samples))
            if workers == 1:
                for offset, count in chunks:
                    save(calculate_chunk(first.isoformat(), offset, count, step))
            else:
                # At most workers results/futures: RAM remains bounded even if
                # one chunk computes slowly. Each Swiss engine has its own process.
                with ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context('spawn')) as pool:
                    pending = set()
                    def submit_next():
                        task = next(chunks, None)
                        if task is not None:
                            pending.add(pool.submit(calculate_chunk, first.isoformat(), *task, step))
                    for _ in range(workers):
                        submit_next()
                    while pending:
                        ready, pending = wait(pending, return_when=FIRST_COMPLETED)
                        for task in ready:
                            save(task.result())
                            submit_next()
            stream.flush()
            os.fsync(stream.fileno())
            stream.seek(0)
            digest = hashlib.sha256()
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        metadata = dict(version=version, format=format_text, startUtc=first.isoformat().replace('+00:00', 'Z'),
                        endExclusiveUtc=last.isoformat().replace('+00:00', 'Z'), stepSeconds=step,
                        sampleCount=samples, days=(last-first).days, columns=list(astro.MOMENT_FIELDS),
                        derived=dict(earth='(sun+180)%360', south_node='(north_node+180)%360'), bytes=byte_count,
                        sha256=digest.hexdigest(), engine='Swiss Ephemeris ' + astro.swe.version,
                        flags=astro.FLAGS, nodeModel='true', zodiac='tropical-geocentric-apparent',
                        normalization='production astronomy.longitude with unchanged flags and SWIEPH/MOSEPH validation',
                        boundaryCheck=boundary, generationSeconds=time.perf_counter()-began,
                        preparationWorkers=workers, chunkSamples=chunk_samples,
                        label='Complete supported public transit interval; not a personal birth date')
        if calculation_fingerprint() != provenance['calculationFingerprint']:
            raise ValueError('Calculation inputs changed during lifetime file generation')
        metadata['provenance'] = provenance
        meta_fd, metadata_temporary = tempfile.mkstemp(prefix=metadata_file.name + '.', suffix='.tmp', dir=destination.parent)
        with os.fdopen(meta_fd, 'w') as stream:
            json.dump(metadata, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        # Metadata is the completion marker. Each destination is published only
        # after all its bytes are final; readers never see partially written data.
        publish_new(temporary, destination)
        temporary = None
        publish_new(metadata_temporary, metadata_file)
        metadata_temporary = None
        return metadata
    finally:
        for filename in (temporary, metadata_temporary):
            if filename:
                Path(filename).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file', required=True)
    parser.add_argument('--start', default='1801-01-01')
    parser.add_argument('--end', default='2400-01-01')
    parser.add_argument('--workers', type=int, default=3)
    args = parser.parse_args()
    last_progress = [0.0]
    def progress(value):
        now = time.monotonic()
        if now-last_progress[0] >= 5 or value['completedSamples'] == value['totalSamples']:
            print(json.dumps(value), flush=True)
            last_progress[0] = now
    metadata = generate_lifetime_file(args.file, args.start, args.end, args.workers, progress)
    print(json.dumps(dict(file=str(Path(args.file).resolve()), samples=metadata['sampleCount'],
                          bytes=metadata['bytes'], sha256=metadata['sha256'],
                          generationSeconds=metadata['generationSeconds'])), flush=True)


if __name__ == '__main__':
    main()
