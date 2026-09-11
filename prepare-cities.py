"""Build a local searchable city gazetteer from the original GeoNames dump."""
import json
import pathlib
import sys
import zipfile

root = pathlib.Path(__file__).parent
archive, regions_path = map(pathlib.Path, sys.argv[1:3])
regions = {}
for line in regions_path.read_text(encoding='utf-8').splitlines():
    columns = line.split('\t')
    if len(columns) >= 2:
        regions[columns[0]] = columns[1]
result = []
with zipfile.ZipFile(archive) as z:
    filename = next(name for name in z.namelist() if name.endswith('.txt'))
    for line in z.read(filename).decode('utf-8').splitlines():
        c = line.split('\t')
        if len(c) < 19 or not c[17]:
            continue
        aliases = c[3].split(',')
        russian = next((alias for alias in aliases if alias and all(ch.isdigit() or ch.isspace() or '\u0400' <= ch <= '\u04ff' or ch in "-’'()." for ch in alias)), None)
        result.append({'id': c[0], 'name': russian or c[1], 'country': c[8], 'region': regions.get(c[8] + '.' + c[10], c[10]), 'timezone': c[17], 'latitude': float(c[4]), 'longitude': float(c[5]), 'population': int(c[14] or 0), 'aliases': list(dict.fromkeys([c[1], c[2], *aliases]))})
result.sort(key=lambda c: -c['population'])
(root / 'data').mkdir(exist_ok=True)
(root / 'data' / 'cities.json').write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(f'GeoNames: {len(result)} cities prepared.')
