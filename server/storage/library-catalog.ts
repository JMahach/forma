import type {Database} from './database.ts';
import type {LibraryCatalogEntry} from '../../shared/library-catalog-contract.ts';
import {cardSourceKey,natalDaySourceKey,returnSourceKey,validMajorReturnsPackage} from '../../shared/library-package-contract.ts';
import {MAIN_RETURN_BODIES,isMainReturnBody,mainReturnRange,type MainReturnBody} from '../../shared/chart-return-contract.ts';
import {validCycleResult,type CycleEventsResult} from '../../shared/cycles-format.ts';
import type {createReturnPackets} from './library-packages.ts';

interface CatalogRow {
  id:string;revision:number;name:string;source:'calculated'|'transit';birthDate:string;birthTime:string;
  utc:string;timezone:string;dayReady:number;families:string;
}
const advance=`INSERT INTO library_catalog_markers(accountId,marker) VALUES(?,1)
  ON CONFLICT(accountId) DO UPDATE SET marker=marker+1`;
type ReturnReader=Pick<ReturnType<typeof createReturnPackets>,'read'|'readFamily'>;
interface FamilySource {accountId:number;utc:string;timezone:string;source:string;ready:number}

function completeFamily(chartId:string,body:MainReturnBody,source:FamilySource,packets:ReturnReader,keys:()=>Set<string>) {
  const origin={birthUtc:source.utc,timezone:source.timezone},range=mainReturnRange(source.utc);
  if(!range)return false;
  const input={...origin,...range,body},dates=packets.read({chartId,action:'events',body,eventUtc:''});
  if(!validCycleResult('events',dates,input))return false;
  const events=(dates as CycleEventsResult).events;if(events.length>2000)return false;
  const available=keys();
  for(const event of events)if(!available.has(event.utc))return false;
  // Missing keys are decided without decoding full calculations. Verify payloads only when all are present.
  const parts=packets.readFamily(chartId,body),ref={kind:'major-returns' as const,sourceKey:returnSourceKey(origin),family:body};
  return validMajorReturnsPackage(ref,{source:origin,family:body,dates:parts.dates,charts:events.map(event=>parts.charts.get(event.utc))});
}

class FamilyReadiness {
  private database:Database;
  private packets:ReturnReader;
  private checking=new Set<string>();
  private source;
  private keys;
  private insert;
  private remove;
  private removeAll;
  private owner;
  private advance;
  constructor(database:Database,packets:ReturnReader) {
    this.database=database;this.packets=packets;const sql=database.connection;
    this.source=sql.prepare(`SELECT c.accountId,json_extract(c.content,'$.utc') AS utc,
      COALESCE(NULLIF(json_extract(c.content,'$.timezone'),''),'UTC') AS timezone,json_extract(c.content,'$.source') AS source,
      EXISTS(SELECT 1 FROM library_ready_families f WHERE f.chartId=c.id AND f.body=?) AS ready FROM account_charts c WHERE c.id=?`);
    this.keys=sql.prepare("SELECT eventUtc FROM account_chart_returns WHERE chartId=? AND body=? AND action='chart'");
    this.insert=sql.prepare('INSERT INTO library_ready_families VALUES(?,?)');
    this.remove=sql.prepare('DELETE FROM library_ready_families WHERE chartId=? AND body=?');
    this.removeAll=sql.prepare('DELETE FROM library_ready_families WHERE chartId=?');
    this.owner=sql.prepare('SELECT accountId FROM account_charts WHERE id=?');this.advance=sql.prepare(advance);
  }
  sync(chartId:string,body:string) {
    if(!isMainReturnBody(body))return;
    const key=JSON.stringify([chartId,body]);if(this.checking.has(key))return;
    this.checking.add(key);
    try {
      this.database.transaction(()=>{
        const source=this.source.get(body,chartId) as unknown as FamilySource|undefined;if(!source)return;
        const ready=source.source==='calculated' && completeFamily(chartId,body,source,this.packets,
          ()=>new Set((this.keys.all(chartId,body) as {eventUtc:string}[]).map(row=>row.eventUtc)));
        if(ready===!!source.ready)return;
        if(ready)this.insert.run(chartId,body);else this.remove.run(chartId,body);
        this.advance.run(source.accountId);
      });
    } finally {this.checking.delete(key);}
  }
  clear(chartId:string) {
    this.database.transaction(()=>{
      if(!this.removeAll.run(chartId).changes)return;
      const owner=this.owner.get(chartId) as {accountId:number}|undefined;if(owner)this.advance.run(owner.accountId);
    });
  }
  migrate() {
    const sql=this.database.connection;
    this.database.transaction(()=>{
      if(sql.prepare("SELECT 1 FROM chart_storage_migrations WHERE name='library_catalog_readiness'").get())return;
      for(const row of sql.prepare("SELECT id FROM account_charts WHERE json_extract(content,'$.source')='calculated'").iterate() as Iterable<{id:string}>)
        for(const body of MAIN_RETURN_BODIES)this.sync(row.id,body);
      sql.prepare("INSERT INTO chart_storage_migrations VALUES('library_catalog_readiness')").run();
    });
  }
}
function entry(row:CatalogRow):LibraryCatalogEntry {
  const {id,revision,name,source,birthDate,birthTime}=row;
  const families=new Set(JSON.parse(row.families) as string[]);
  return {id,revision,name,source,birthDate,birthTime,packages:{card:{kind:'card',sourceKey:cardSourceKey(row)},
    day:source==='calculated'?{ref:{kind:'day',sourceKey:natalDaySourceKey({date:birthDate,timezone:row.timezone})},ready:!!row.dayReady}:null,
    majorReturns:source==='calculated'?{sourceKey:returnSourceKey({birthUtc:row.utc,timezone:row.timezone}),
      readyFamilies:MAIN_RETURN_BODIES.filter(body=>families.has(body))}:null}};
}

/** Materialized availability contains no numerical payload. An unchanged request reads only its counter. */
export function createLibraryCatalogStorage(database:Database,packets:ReturnReader) {
  const sql=database.connection;
  sql.exec(`CREATE TABLE IF NOT EXISTS library_catalog_markers (
    accountId INTEGER PRIMARY KEY REFERENCES accounts(id),marker INTEGER NOT NULL CHECK(marker>0)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS library_ready_families (
    chartId TEXT NOT NULL REFERENCES account_charts(id) ON DELETE CASCADE ON UPDATE CASCADE,
    body TEXT NOT NULL,PRIMARY KEY(chartId,body)
  ) STRICT;`);
  for(const [operation,reference] of [['INSERT','NEW'],['DELETE','OLD']] as const) {
    sql.exec(`CREATE TRIGGER IF NOT EXISTS library_catalog_chart_${operation.toLowerCase()} AFTER ${operation} ON account_charts BEGIN
      ${advance.replace('?',reference+'.accountId')}; END;`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS library_catalog_day_${operation.toLowerCase()} AFTER ${operation} ON library_natal_days BEGIN
      INSERT INTO library_catalog_markers(accountId,marker)
      SELECT DISTINCT c.accountId,1 FROM library_natal_day_refs r JOIN account_charts c ON c.id=r.chartId
      WHERE r.sourceKey=${reference}.sourceKey
      ON CONFLICT(accountId) DO UPDATE SET marker=marker+1; END;`);
  }
  sql.exec(`CREATE TRIGGER IF NOT EXISTS library_catalog_chart_update AFTER UPDATE OF id,revision,content ON account_charts
    WHEN OLD.id IS NOT NEW.id OR OLD.revision IS NOT NEW.revision OR OLD.content IS NOT NEW.content BEGIN
    ${advance.replace('?','NEW.accountId')}; END;`);
  const marker=sql.prepare('SELECT CAST(marker AS TEXT) AS marker FROM library_catalog_markers WHERE accountId=?');
  const page=sql.prepare(`SELECT c.id,c.revision,json_extract(c.content,'$.name') AS name,
    json_extract(c.content,'$.source') AS source,json_extract(c.content,'$.birthDate') AS birthDate,
    json_extract(c.content,'$.birthTime') AS birthTime,json_extract(c.content,'$.utc') AS utc,
    COALESCE(NULLIF(json_extract(c.content,'$.timezone'),''),'UTC') AS timezone,
    EXISTS(SELECT 1 FROM library_natal_days d JOIN library_natal_day_refs r ON r.sourceKey=d.sourceKey WHERE r.chartId=c.id) AS dayReady,
    (SELECT json_group_array(body) FROM library_ready_families f WHERE f.chartId=c.id) AS families
    FROM account_charts c WHERE c.accountId=? AND c.id>? ORDER BY c.id LIMIT ?`);
  const readiness=new FamilyReadiness(database,packets);readiness.migrate();
  return {
    marker(accountId:string) {return (marker.get(accountId) as {marker:string}|undefined)?.marker??'0';},
    page(accountId:string,after:string,limit:number) {return (page.all(accountId,after,limit) as unknown as CatalogRow[]).map(entry);},
    returnChanged:(chartId:string,body:string)=>readiness.sync(chartId,body),
    clearReturns:(chartId:string)=>readiness.clear(chartId),
  };
}
