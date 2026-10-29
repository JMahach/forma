import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCityCatalog } from '../server/services/cities.ts';
type CatalogCity=Parameters<typeof createCityCatalog>[0][number];
const normalize=(text:unknown)=>String(text).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/ё/g,'е').trim();
// The original three-pass predicates are a behavioral oracle for ordering and alias selection.
function previousSearch(cities:CatalogCity[],query:unknown) {
 const q=normalize(query).slice(0,80);if(q.length<2)return [];
 const exact:CatalogCity[]=[],prefix:CatalogCity[]=[],rest:CatalogCity[]=[];
 for(const city of cities) {
  const names=[...new Set([city.name,...city.aliases].map(normalize))];
  if(names.some(name=>name===q)){exact.push(city);if(exact.length===12)break;}
  else if(prefix.length<12 && names.some(name=>name.startsWith(q)))prefix.push(city);
  else if(rest.length<12 && names.some(name=>name.includes(q)))rest.push(city);
 }
 return [...exact,...prefix,...rest].slice(0,12).map(city=>{
  const alias=city.aliases.find(name=>normalize(name)===q)||city.aliases.find(name=>normalize(name).startsWith(q));
  return {id:city.id,name:alias||city.aliases[0]||city.name,country:city.country,region:city.region,
   timezone:city.timezone,latitude:city.latitude,longitude:city.longitude};
 });
}
test('one-pass matching preserves public catalog exact/prefix/infix ranking, aliases and limit',()=>{
 const cities=JSON.parse(fs.readFileSync(new URL('../data/cities.json',import.meta.url),'utf8')) as CatalogCity[];
 const queries=new Set<unknown>(['Мо','Москва','zzzzzzzzzz-not-a-city','  МОСКВА  ','ё','ab','сан','new','north',null,42,'a'.repeat(90)]);
 for(let i=0;i<36;i++){const city=cities[Math.floor(i*cities.length/36)]!;queries.add(city.name);queries.add(city.name.slice(0,3));}
 const catalog=createCityCatalog(cities);
 for(const query of queries)assert.deepEqual(catalog.search(query),previousSearch(cities,query),String(query));
});
test('late exact aliases outrank full prefix and infix buckets without changing within-rank order',()=>{
 const cities=Array.from({length:60},(_,i)=>({id:String(i),name:i<18?'ab'+i:'other'+i,
  aliases:i<12?['abc'+i]:i<42?['infix ab '+i]:['ab','abc late '+i],country:'X',region:'R',timezone:'UTC',latitude:0,longitude:0}));
 const catalog=createCityCatalog(cities);
 for(const query of ['ab','abc','infix','no','AB'])assert.deepEqual(catalog.search(query),previousSearch(cities,query));
 let random=97;
 const next=()=>{random=(random*16807)%2147483647;return random;};
 for(let iteration=0;iteration<30;iteration++) {
  const shuffled=cities.toSorted(()=>next()%3-1);
  for(const query of ['ab','abc','infix'])assert.deepEqual(createCityCatalog(shuffled).search(query),previousSearch(shuffled,query));
 }
});
