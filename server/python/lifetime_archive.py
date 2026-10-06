"""Prepare an exact planetary archive; never run in the HTTP request path.

Example: python -m server.python.lifetime_archive --file /path/all.f64le
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


def shared_literal(name):
    """Read only literal declarations, without evaluating JavaScript or Node."""
    source = (ROOT / 'shared/lifetime-format.js').read_text()
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


def archive_format():
    planets = shared_literal('LIFETIME_PLANETS')
    step = shared_literal('LIFETIME_STEP_SECONDS')
    if not isinstance(planets, list) or not planets or len(set(planets)) != len(planets):
        raise ValueError('Invalid shared planet order')
    if not isinstance(step, int) or step < 1 or 86400 % step:
        raise ValueError('Invalid shared sample interval')
    return planets, step, shared_literal('LIFETIME_ARCHIVE_VERSION'), shared_literal('LIFETIME_ARCHIVE_FORMAT')


def bodies_for(planets):
    return [astro.swe.TRUE_NODE if name == 'north_node' else getattr(astro.swe, name.upper()) for name in planets]


def interval(start, end):
    first, last = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    if first.isoformat() != start or last.isoformat() != end or not MIN_DATE <= first < last <= MAX_DATE:
        raise ValueError('Archive interval must be within 1801-01-01 through 2400-01-01 exclusive')
    return dt.datetime.combine(first, dt.time(), UTC), dt.datetime.combine(last, dt.time(), UTC)


def boundary_check(start, end, planets, step):
    results = []
    for moment in (start, end - dt.timedelta(seconds=step)):
        jd = astro.julian_tt(moment)
        values = [astro.longitude(jd, body) for body in bodies_for(planets)]
        results.append(dict(utc=moment.isoformat().replace('+00:00', 'Z'), longitudes=values))
    return results


def calculate_chunk(start_iso, offset, count, planets, step):
    start = dt.datetime.fromisoformat(start_iso)
    bodies = bodies_for(planets)
    columns = [array.array('d') for _ in planets]
    if columns[0].itemsize != 8:
        raise RuntimeError('Float64 arrays are required')
    for index in range(offset, offset + count):
        jd = astro.julian_tt(start + dt.timedelta(seconds=index * step))
        for column, body in zip(columns, bodies):
            column.append(astro.longitude(jd, body))
    if sys.byteorder != 'little':
        for column in columns:
            column.byteswap()
    return offset, [column.tobytes() for column in columns]


def publish_new(temporary, destination):
    # A same-filesystem hard link publishes complete bytes atomically AND fails
    # if the destination already exists. Unlike os.replace it cannot overwrite
    # a completed archive from a concurrent preparation run.
    os.link(temporary, destination)
    os.unlink(temporary)


def copy_reused_columns(destination, file, planets, samples, first, last, step, version, format_text, provenance):
    """Copy compatible columns into the temporary output, verifying all source bytes.

    Version 1 is accepted only here for migrating the earlier subset archive.
    No copied data is published or missing data computed until SHA256 agrees.
    """
    source = Path(file)
    metadata_file = source.with_suffix('.metadata.json')
    if metadata_file.stat().st_size > 16_384:
        raise ValueError('Reuse metadata is too large')
    metadata = json.loads(metadata_file.read_text())
    if not isinstance(metadata, dict):
        raise ValueError('Invalid reuse metadata')
    if 'provenance' in metadata and metadata['provenance'] != provenance:
        raise ValueError('Incompatible reuse provenance')
    columns = metadata.get('columns')
    if (metadata.get('version') not in ('1', version) or metadata.get('format') != format_text
        or not isinstance(columns, list) or not columns or any(name not in planets for name in columns)
        or len(set(columns)) != len(columns)
        or metadata.get('sampleCount') != samples or metadata.get('stepSeconds') != step
        or metadata.get('startUtc') != first.isoformat().replace('+00:00', 'Z')
        or metadata.get('endExclusiveUtc') != last.isoformat().replace('+00:00', 'Z')
        or metadata.get('flags') != astro.FLAGS
        or metadata.get('engine') != 'Swiss Ephemeris ' + astro.swe.version
        or not isinstance(metadata.get('sha256'), str)
        or not re.fullmatch(r'[a-f0-9]{64}', metadata['sha256'])):
        raise ValueError('Incompatible reuse metadata')
    column_bytes = samples * 8
    byte_count = column_bytes * len(columns)
    if metadata.get('bytes') != byte_count or not source.is_file() or source.stat().st_size != byte_count:
        raise ValueError('Incorrect reuse archive size')
    digest = hashlib.sha256()
    with source.open('rb') as stream:
        # Read in source order for one sequential hash pass; each destination
        # column has an explicit position, so any compatible subset order works.
        for planet in columns:
            destination.seek(planets.index(planet) * column_bytes)
            remaining = column_bytes
            while remaining:
                payload = stream.read(min(1024 * 1024, remaining))
                if not payload:
                    raise ValueError('Short reuse archive read')
                digest.update(payload)
                destination.write(payload)
                remaining -= len(payload)
        if stream.read(1) or digest.hexdigest() != metadata['sha256']:
            raise ValueError('Reuse archive SHA256 mismatch')
    result = dict(version=metadata['version'], columns=columns, sha256=metadata['sha256'])
    if 'provenance' in metadata:
        result['provenance'] = metadata['provenance']
    return result


def generate_archive(file, start='1801-01-01', end='2400-01-01', workers=3, progress=None, reuse_file=None):
    destination = Path(file)
    if destination.suffix != '.f64le':
        raise ValueError('Archive file must end in .f64le')
    metadata_file = destination.with_suffix('.metadata.json')
    if destination.exists() or metadata_file.exists():
        raise FileExistsError('Refusing to overwrite an existing archive or metadata file')
    if not isinstance(workers, int) or not 1 <= workers <= 8:
        raise ValueError('Use between one and eight preparation workers')
    first, last = interval(start, end)
    planets, step, version, format_text = archive_format()
    provenance = dict(version='1', calculationFingerprint=calculation_fingerprint())
    boundary = boundary_check(first, last, planets, step)
    samples = int((last - first).total_seconds()) // step
    chunk_samples = 90 * 86400 // step
    byte_count = samples * len(planets) * 8
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
            reused = copy_reused_columns(stream, reuse_file, planets, samples, first, last, step, version, format_text, provenance) if reuse_file else None
            computed_planets = [name for name in planets if not reused or name not in reused['columns']]
            computed_offsets = [planets.index(name) for name in computed_planets]
            def save(result):
                nonlocal completed
                offset, columns = result
                count = len(columns[0]) // 8
                for column, payload in zip(computed_offsets, columns):
                    stream.seek((column * samples + offset) * 8)
                    stream.write(payload)
                completed += count
                report()
            chunks = iter((offset, min(chunk_samples, samples - offset)) for offset in range(0, samples, chunk_samples))
            if not computed_planets:
                completed = samples
                report()
            elif workers == 1:
                for offset, count in chunks:
                    save(calculate_chunk(first.isoformat(), offset, count, computed_planets, step))
            else:
                # At most workers results/futures: RAM remains bounded even if
                # one quarter computes slowly. Each Swiss engine has its own process.
                with ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context('spawn')) as pool:
                    pending = set()
                    def submit_next():
                        task = next(chunks, None)
                        if task is not None:
                            pending.add(pool.submit(calculate_chunk, first.isoformat(), *task, computed_planets, step))
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
                        sampleCount=samples, days=(last-first).days, columns=planets,
                        derived=dict(earth='(sun+180)%360', south_node='(north_node+180)%360'), bytes=byte_count,
                        sha256=digest.hexdigest(), engine='Swiss Ephemeris ' + astro.swe.version,
                        flags=astro.FLAGS, nodeModel='true', zodiac='tropical-geocentric-apparent',
                        normalization='production astronomy.longitude with unchanged flags and SWIEPH/MOSEPH validation',
                        boundaryCheck=boundary, generationSeconds=time.perf_counter()-began,
                        preparationWorkers=workers, chunkSamples=chunk_samples,
                        label='Complete supported public transit interval; not a personal birth date')
        if reused:
            metadata['reusedArchive'] = reused
            metadata['computedColumns'] = computed_planets
        if calculation_fingerprint() != provenance['calculationFingerprint']:
            raise ValueError('Calculation inputs changed during archive generation')
        # Unknown copied columns must never acquire the current fingerprint.
        if not reused or reused.get('provenance') == provenance:
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
    parser.add_argument('--reuse-file', help='Reuse verified compatible columns from an existing archive')
    args = parser.parse_args()
    last_progress = [0.0]
    def progress(value):
        now = time.monotonic()
        if now-last_progress[0] >= 5 or value['completedSamples'] == value['totalSamples']:
            print(json.dumps(value), flush=True)
            last_progress[0] = now
    metadata = generate_archive(args.file, args.start, args.end, args.workers, progress, args.reuse_file)
    print(json.dumps(dict(file=str(Path(args.file).resolve()), samples=metadata['sampleCount'],
                          bytes=metadata['bytes'], sha256=metadata['sha256'],
                          generationSeconds=metadata['generationSeconds'])), flush=True)


if __name__ == '__main__':
    main()
