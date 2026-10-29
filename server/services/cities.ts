import type { City } from '../../shared/chart-types.ts';
export type { City } from '../../shared/chart-types.ts';
interface CatalogCity extends City { aliases: string[] }
export type CityCatalog = ReturnType<typeof createCityCatalog>;

import fs from 'node:fs/promises';

const normalize = (text: unknown) => String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ё/g, 'е').trim();
function publicCity(city: CatalogCity, label?: string) {
  const { id, country, region, timezone, latitude, longitude } = city;
  const name = label && city.aliases.includes(label) ? label : city.aliases[0] || city.name;
  return { id, name, country, region, timezone, latitude, longitude };
}

export function createCityCatalog(cities: CatalogCity[]) {
  const index = new Map(cities.map(city => [String(city.id), city]));
  const searchable = cities.map(city => ({ city, names: [...new Set([city.name, ...city.aliases].map(normalize))] }));
  return {
    find(id: unknown, label?: string) {
      const city = index.get(String(id));
      return city ? publicCity(city, label) : null;
    },
    search(query: unknown) {
      const q = normalize(query).slice(0, 80);
      if (q.length < 2) return [];
      const exact: CatalogCity[] = [], prefix: CatalogCity[] = [], rest: CatalogCity[] = [];
      for (const { city, names } of searchable) {
        let match = 0;
        for (const name of names) {
          // Once lower ranks are full, only an exact match can improve this city's rank.
          if (match === 2 || prefix.length >= 12 && (match === 1 || rest.length >= 12)) {
            if (name === q) { match = 3; break; }
            continue;
          }
          const at = name.indexOf(q);
          if (at === 0 && name.length === q.length) { match = 3; break; }
          if (at === 0 && prefix.length < 12) match = 2;
          else if (at >= 0 && rest.length < 12 && match < 1) match = 1;
        }
        if (match === 3) { exact.push(city); if (exact.length === 12) break; }
        else if (match === 2) prefix.push(city);
        else if (match === 1) rest.push(city);
      }
      return [...exact, ...prefix, ...rest].slice(0, 12).map(city => {
        const alias = city.aliases.find(name => normalize(name) === q) || city.aliases.find(name => normalize(name).startsWith(q));
        return publicCity(city, alias);
      });
    },
  };
}

export async function loadCityCatalog(filename: string) {
  return createCityCatalog(JSON.parse(await fs.readFile(filename, 'utf8')));
}
