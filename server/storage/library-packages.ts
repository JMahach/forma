import {createHash} from 'node:crypto';
import {brotliDecompressSync,gunzipSync,gzipSync} from 'node:zlib';
import type {Database} from './database.ts';
import type {DayPacket} from '../packets/compression.ts';
import {decodeNatalDay} from '../../shared/day-packets/decode.ts';
import {NATAL_DAY_MAX_HEADER_BYTES,NATAL_DAY_MAX_SAMPLES,NATAL_DAY_COLUMNS} from '../../shared/day-packets/natal-format.ts';
import {natalDaySourceKey,type NatalDaySource,type PackagePlacement} from '../../shared/library-package-contract.ts';

const MAX_BYTES=8+NATAL_DAY_MAX_HEADER_BYTES+NATAL_DAY_MAX_SAMPLES*NATAL_DAY_COLUMNS*8;
const digest=(key:string,bytes:Uint8Array)=>createHash('sha256').update(key).update('\0').update(bytes).digest('hex');
interface DayRow {br:Uint8Array;gzip:Uint8Array;identityBytes:number;identityHash:string;brHash:string;gzipHash:string}

function packetFromRow(key:string,row:DayRow):DayPacket|null {
  if(row.identityBytes<8 || row.identityBytes>MAX_BYTES || row.br.length>MAX_BYTES || row.gzip.length>MAX_BYTES
    || digest(key,row.br)!==row.brHash || digest(key,row.gzip)!==row.gzipHash)return null;
  const br=Buffer.from(row.br),gzip=Buffer.from(row.gzip);
  return {bytes:{br,gzip,get identity(){
    const raw=brotliDecompressSync(br,{maxOutputLength:row.identityBytes});
    if(raw.length!==row.identityBytes || digest(key,raw)!==row.identityHash)throw Error('Invalid stored natal day');
    return raw;
  }}};
}
function verifyDay(source:NatalDaySource,packet:DayPacket) {
  const raw=packet.bytes.identity,day=decodeNatalDay(raw);
  if(day.date!==source.date || day.timezone!==source.timezone
    || !brotliDecompressSync(packet.bytes.br,{maxOutputLength:MAX_BYTES}).equals(raw)
    || !gunzipSync(packet.bytes.gzip,{maxOutputLength:MAX_BYTES}).equals(raw))throw Error('Invalid natal day package');
}

/** Durable prepared bytes belong to saved sources; the ordinary RAM cache has its own lifetime. */
export function createLibraryPackages(database:Database) {
  const sql=database.connection;
  sql.exec(`CREATE TABLE IF NOT EXISTS library_natal_days (
    sourceKey TEXT PRIMARY KEY, br BLOB NOT NULL, gzip BLOB NOT NULL,
    identityBytes INTEGER NOT NULL, identityHash TEXT NOT NULL, brHash TEXT NOT NULL, gzipHash TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS library_natal_day_refs (
    chartId TEXT PRIMARY KEY REFERENCES account_charts(id) ON DELETE CASCADE ON UPDATE CASCADE,
    sourceKey TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS library_natal_day_source ON library_natal_day_refs(sourceKey);
  CREATE TRIGGER IF NOT EXISTS library_natal_day_retire AFTER DELETE ON library_natal_day_refs BEGIN
    DELETE FROM library_natal_days WHERE sourceKey=OLD.sourceKey
      AND NOT EXISTS (SELECT 1 FROM library_natal_day_refs WHERE sourceKey=OLD.sourceKey);
  END;
  CREATE TRIGGER IF NOT EXISTS library_natal_day_add AFTER INSERT ON account_charts
    WHEN json_extract(NEW.content,'$.source')='calculated' BEGIN
    INSERT INTO library_natal_day_refs VALUES(NEW.id,json_array(json_extract(NEW.content,'$.birthDate'),json_extract(NEW.content,'$.timezone')));
  END;
  CREATE TRIGGER IF NOT EXISTS library_natal_day_change AFTER UPDATE OF content ON account_charts
    WHEN json_extract(OLD.content,'$.source') IS NOT json_extract(NEW.content,'$.source')
      OR json_extract(OLD.content,'$.birthDate') IS NOT json_extract(NEW.content,'$.birthDate')
      OR json_extract(OLD.content,'$.timezone') IS NOT json_extract(NEW.content,'$.timezone') BEGIN
    DELETE FROM library_natal_day_refs WHERE chartId=NEW.id;
    INSERT INTO library_natal_day_refs SELECT NEW.id,json_array(json_extract(NEW.content,'$.birthDate'),json_extract(NEW.content,'$.timezone'))
      WHERE json_extract(NEW.content,'$.source')='calculated';
  END;`);
  database.transaction(()=>{
    if(sql.prepare("SELECT 1 FROM chart_storage_migrations WHERE name='natal_day_references'").get())return;
    sql.exec(`INSERT OR IGNORE INTO library_natal_day_refs
      SELECT id,json_array(json_extract(content,'$.birthDate'),json_extract(content,'$.timezone'))
      FROM account_charts WHERE json_extract(content,'$.source')='calculated';`);
    sql.prepare("INSERT INTO chart_storage_migrations VALUES ('natal_day_references')").run();
  });
  const read=sql.prepare('SELECT * FROM library_natal_days WHERE sourceKey=?');
  const remove=sql.prepare('DELETE FROM library_natal_days WHERE sourceKey=?');
  const reference=sql.prepare('SELECT 1 FROM library_natal_day_refs WHERE sourceKey=? LIMIT 1');
  const exists=sql.prepare('SELECT 1 FROM library_natal_days WHERE sourceKey=?');
  const insert=sql.prepare('INSERT INTO library_natal_days VALUES(?,?,?,?,?,?,?)');
  return {
    readDay(source:NatalDaySource):DayPacket|null {
      const key=natalDaySourceKey(source),row=read.get(key) as unknown as DayRow|undefined;
      if(!row)return null;
      const packet=packetFromRow(key,row);
      if(!packet)remove.run(key);
      return packet;
    },
    putDay(source:NatalDaySource,packet:DayPacket):PackagePlacement {
      const key=natalDaySourceKey(source);
      if(!reference.get(key))return 'stale';
      if(exists.get(key))return 'no-op';
      verifyDay(source,packet);
      const {identity,br,gzip}=packet.bytes;
      return database.transaction(()=>{
        if(!reference.get(key))return 'stale';
        if(exists.get(key))return 'no-op';
        insert.run(key,br,gzip,identity.length,digest(key,identity),digest(key,br),digest(key,gzip));
        return 'stored';
      });
    },
  };
}
export type LibraryPackages=ReturnType<typeof createLibraryPackages>;

interface ReturnAddress {chartId:string;action:'events'|'chart';body:string;eventUtc:string}
interface ReturnRow {content:Uint8Array;checksum:string;rawDigest:string}
type CompressReturn=(raw:Buffer)=>Uint8Array;
const MAX_RETURN_BYTES=2_000_000;
const returnKey=({action,body,eventUtc}:ReturnAddress)=>JSON.stringify([action,body,eventUtc]);
// Node24 supports rawJSON; the shared browser compilation deliberately targets ES2023.
// The output is ordinary JSON. Native JSON.parse restores its legal -0 numeric literal.
const rawJSON=(JSON as typeof JSON & {rawJSON(text:string):object}).rawJSON;
function returnBytes(value:unknown):Buffer {
  const text=JSON.stringify(value,(_key,item)=>Object.is(item,-0)?rawJSON('-0'):item);
  if(typeof text!=='string' || Buffer.byteLength(text)>MAX_RETURN_BYTES)throw Error('Invalid prepared return');
  return Buffer.from(text);
}
function packReturn(key:string,raw:Buffer,compress:CompressReturn,rawDigest=digest(key,raw)):ReturnRow {
  const content=compress(raw);
  if(content.length>MAX_RETURN_BYTES+1024 || !gunzipSync(content,{maxOutputLength:MAX_RETURN_BYTES}).equals(raw))
    throw Error('Invalid compressed return');
  return {content,checksum:digest(key,content),rawDigest};
}
function compressedReturnValid(key:string,row:ReturnRow) {
  return row.content.length<=MAX_RETURN_BYTES+1024 && digest(key,row.content)===row.checksum;
}
function unpackReturn(key:string,row:ReturnRow):unknown {
  if(!compressedReturnValid(key,row))throw Error('Invalid stored return');
  const raw=gunzipSync(row.content,{maxOutputLength:MAX_RETURN_BYTES});
  if(digest(key,raw)!==row.rawDigest)throw Error('Invalid stored return');
  return JSON.parse(raw.toString('utf8'));
}
function returnTable(name:'account_chart_returns'|'account_chart_returns_next') {
  return `CREATE TABLE ${name==='account_chart_returns'?'IF NOT EXISTS ':''}${name} (
    chartId TEXT NOT NULL REFERENCES account_charts(id) ON DELETE CASCADE ON UPDATE CASCADE,
    action TEXT NOT NULL CHECK(action IN ('events','chart')),body TEXT NOT NULL,eventUtc TEXT NOT NULL,
    content BLOB NOT NULL,checksum TEXT NOT NULL,rawDigest TEXT NOT NULL,
    PRIMARY KEY(chartId,action,body,eventUtc),
    CHECK((action='events' AND eventUtc='') OR (action='chart' AND length(eventUtc)>0))
  ) STRICT;`;
}
function migrateReturnPackets(database:Database,compress:CompressReturn) {
  const sql=database.connection;
  database.transaction(()=>{
    const column=sql.prepare("SELECT type FROM pragma_table_info('account_chart_returns') WHERE name='content'").get() as {type:string}|undefined;
    if(column?.type!=='TEXT')return;
    sql.exec(returnTable('account_chart_returns_next'));
    const insert=sql.prepare('INSERT INTO account_chart_returns_next VALUES(?,?,?,?,?,?,?)');
    for(const row of sql.prepare('SELECT chartId,action,body,eventUtc,content FROM account_chart_returns').iterate() as unknown as Iterable<ReturnAddress & {content:string}>) {
      const packet=packReturn(returnKey(row),returnBytes(JSON.parse(row.content)),compress);
      insert.run(row.chartId,row.action,row.body,row.eventUtc,packet.content,packet.checksum,packet.rawDigest);
    }
    sql.exec('DROP TABLE account_chart_returns; ALTER TABLE account_chart_returns_next RENAME TO account_chart_returns;');
  });
}

/** Prepared parts are written once; repeated reads only verify and decompress stored bytes. */
export function createReturnPackets(database:Database,{compress=(raw:Buffer)=>gzipSync(raw,{level:9})}:{compress?:CompressReturn}={}) {
  const sql=database.connection;
  sql.exec(returnTable('account_chart_returns'));
  migrateReturnPackets(database,compress);
  const read=sql.prepare('SELECT content,checksum,rawDigest FROM account_chart_returns WHERE chartId=? AND action=? AND body=? AND eventUtc=?');
  const remove=sql.prepare('DELETE FROM account_chart_returns WHERE chartId=? AND action=? AND body=? AND eventUtc=?');
  const insert=sql.prepare(`INSERT INTO account_chart_returns VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(chartId,action,body,eventUtc) DO UPDATE SET content=excluded.content,checksum=excluded.checksum,rawDigest=excluded.rawDigest`);
  const clear=sql.prepare('DELETE FROM account_chart_returns WHERE chartId=?');
  const keyArgs=({chartId,action,body,eventUtc}:ReturnAddress)=>[chartId,action,body,eventUtc];
  return {
    read(address:ReturnAddress):unknown {
      const args=keyArgs(address),row=read.get(...args) as unknown as ReturnRow|undefined;
      if(!row)return null;
      try {return unpackReturn(returnKey(address),row);}
      catch {remove.run(...args);return null;}
    },
    save(address:ReturnAddress,value:unknown):boolean {
      const args=keyArgs(address),key=returnKey(address),raw=returnBytes(value),hash=digest(key,raw);
      const previous=read.get(...args) as unknown as ReturnRow|undefined;
      if(previous?.rawDigest===hash && compressedReturnValid(key,previous))return false;
      const packet=packReturn(key,raw,compress,hash);
      insert.run(...args,packet.content,packet.checksum,packet.rawDigest);return true;
    },
    clear(chartId:string){clear.run(chartId);},
  };
}
