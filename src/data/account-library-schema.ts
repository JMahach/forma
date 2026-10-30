import type {PackageRef} from '../../shared/library-package-contract.ts';
import { canonicalChartId } from '../../shared/chart-record-contract.ts';
import { migrateCalculationMetadata } from '../../shared/calculation-storage-transition.ts';

function migrateCard(transaction:IDBTransaction,cursor:IDBCursorWithValue) {
  const value=migrateCalculationMetadata(cursor.value);
  const id=typeof value.id==='string'?canonicalChartId(value.id):value.id;
  const {_accessedAt,...card}=value;
  card.id=id;
  if(Number.isFinite(_accessedAt) && _accessedAt>0)
    transaction.objectStore('usage').put({id,openedAt:_accessedAt});
  if(id!==cursor.primaryKey) {
    const charts=transaction.objectStore('charts'),existing=charts.get(id);
    existing.onsuccess=()=>{
      if(existing.result){transaction.abort();return;}
      charts.put(card);cursor.delete();cursor.continue();
    };
    return;
  }
  if(value!==cursor.value || '_accessedAt' in value)cursor.update(card);
  cursor.continue();
}

/** One atomic upgrade owns identities, numerical metadata and lightweight use.
 * Existing numbers and the account lease survive; old writers are fenced by IDB. */
export function upgradeAccountLibrary(database:IDBDatabase,transaction:IDBTransaction,oldVersion:number) {
  const charts=database.objectStoreNames.contains('charts')?transaction.objectStore('charts')
    :database.createObjectStore('charts',{keyPath:'id'});
  if(charts.indexNames.contains('accessed'))charts.deleteIndex('accessed');
  if(!charts.indexNames.contains('recordRevision'))charts.createIndex('recordRevision',['id','revision']);
  if(!database.objectStoreNames.contains('context'))database.createObjectStore('context',{keyPath:'key'});
  if(!database.objectStoreNames.contains('usage'))database.createObjectStore('usage',{keyPath:'id'});
  upgradePackageSchema(database,charts);
  if(!oldVersion || oldVersion>=5)return;
  const request=charts.openCursor();
  request.onsuccess=()=>{
    const cursor=request.result;if(!cursor)return;
    try {migrateCard(transaction,cursor);}catch {transaction.abort();}
  };
}

export interface LibraryLease {accountId:string;generation:string}
export const validLibraryAccountId=(value:unknown):value is string=>typeof value==='string' && /^[1-9][0-9]{0,19}$/.test(value);
export function readLibraryLease(value:unknown):LibraryLease|null {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const row=value as Record<string,unknown>;
  return validLibraryAccountId(row.accountId) && typeof row.generation==='string' && row.generation
    ?{accountId:row.accountId,generation:row.generation}:null;
}
export function sameLibraryLease(current:unknown,seen:LibraryLease) {
  const value=readLibraryLease(current);return !!value && value.accountId===seen.accountId && value.generation===seen.generation;
}

export interface LibraryPackageMetadata {id:string;ref:Exclude<PackageRef,{kind:"card"}>;chartIds:string[]}

function upgradePackageSchema(database:IDBDatabase,charts:IDBObjectStore) {
  if(!charts.indexNames.contains('recordSource'))charts.createIndex('recordSource',['id','revision','birthDate','timezone','utc']);
  if(!charts.indexNames.contains('natalDay'))charts.createIndex('natalDay',['source','birthDate','timezone']);
  if(!charts.indexNames.contains('returnSource'))charts.createIndex('returnSource',['source','utc','timezone']);
  if(!database.objectStoreNames.contains('packages'))database.createObjectStore('packages',{keyPath:'id'});
  if(!database.objectStoreNames.contains('packageMetadata')) {
    const metadata=database.createObjectStore('packageMetadata',{keyPath:'id'});
    metadata.createIndex('cards','chartIds',{multiEntry:true});
    metadata.createIndex('source','ref.sourceKey');
  }
}
