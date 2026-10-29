import {createHash} from 'node:crypto';
import {brotliDecompressSync,gunzipSync} from 'node:zlib';
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
