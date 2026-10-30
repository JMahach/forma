import { migrateStoredCalculations } from './calculation-transition.ts';
import {createLibraryPackages,createReturnPackets} from './library-packages.ts';
import {createLibraryPreparationStorage} from './library-preparation.ts';
import {createLibraryCatalogStorage} from './library-catalog.ts';
import type { Database } from './database.ts';
import type { AccountChart, AccountChartContent, ChartWriteOutcome } from '../../shared/chart-record-contract.ts';

interface Row {
  id: string; accountId: number; nameKey: string; birthMinute: number;
  revision: number; noteRevision: number; publicRevision: number; content: string;
}
export interface ChartOutcomeRecord { createdAt: number; outcome: ChartWriteOutcome }
function decode(row: Row | undefined): AccountChart | null {
  if (!row) return null;
  return { ...JSON.parse(row.content) as AccountChartContent, id: row.id,
    accountId: String(row.accountId), revision: row.revision, noteRevision: row.noteRevision, publicRevision: row.publicRevision };
}

/** SQL and physical records only. Authorization and mutation meaning belong to the service. */
export function createChartRecordStorage(database: Database, migrateIdentifier?: (id:string)=>string) {
  const sql = database.connection;
  sql.exec(`CREATE TABLE IF NOT EXISTS account_charts (
    id TEXT PRIMARY KEY, accountId INTEGER NOT NULL REFERENCES accounts(id),
    nameKey TEXT NOT NULL, birthMinute INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    noteRevision INTEGER NOT NULL CHECK(noteRevision > 0),
    publicRevision INTEGER NOT NULL DEFAULT 1 CHECK(publicRevision > 0),
    content TEXT NOT NULL,
    UNIQUE(accountId, nameKey, birthMinute)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS account_charts_account_id ON account_charts(accountId,id);
  CREATE INDEX IF NOT EXISTS account_charts_return_source ON account_charts(
    json_extract(content,'$.utc'),COALESCE(NULLIF(json_extract(content,'$.timezone'),''),'UTC'))
    WHERE json_extract(content,'$.source')='calculated';
  CREATE TABLE IF NOT EXISTS chart_operation_outcomes (
    accountId INTEGER NOT NULL REFERENCES accounts(id), operationId TEXT NOT NULL,
    createdAt INTEGER NOT NULL, outcome TEXT NOT NULL,
    PRIMARY KEY(accountId, operationId)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS chart_operation_expiry ON chart_operation_outcomes(createdAt);`);
  migrateStoredCalculations(database);
  let catalog:ReturnType<typeof createLibraryCatalogStorage>;
  const returns=createReturnPackets(database,{onChange:address=>catalog?.returnChanged(address.chartId,address.body),onClear:id=>catalog?.clearReturns(id)});
  // Issued addresses are never recycled after deletion.
  sql.exec(`CREATE TABLE IF NOT EXISTS chart_identifiers (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE IF NOT EXISTS chart_storage_migrations (name TEXT PRIMARY KEY) STRICT;`);
  database.transaction(()=>{
    // Old backups have no marker and seed from both live records and durable outcomes.
    // Old binaries ignore this additive table and retain their existing shortening behavior.
    const applied=sql.prepare('SELECT 1 FROM chart_storage_migrations WHERE name=?');
    const mark=sql.prepare('INSERT INTO chart_storage_migrations VALUES (?)');
    if(!applied.get('issued_identifiers_v1')) {
      sql.exec(`INSERT OR IGNORE INTO chart_identifiers SELECT id FROM account_charts;
        INSERT OR IGNORE INTO chart_identifiers SELECT json_extract(outcome,'$.chartId')
          FROM chart_operation_outcomes WHERE json_extract(outcome,'$.chartId') IS NOT NULL;`);
      mark.run('issued_identifiers_v1');
    }
    if(!migrateIdentifier || applied.get('short_identifiers_v1'))return;
    const ids=(sql.prepare('SELECT id FROM chart_identifiers').all() as {id:string}[]).map(row=>row.id);
    const targets=new Set<string>(),renamed:{id:string;next:string}[]=[];
    for(const id of ids){
      const next=migrateIdentifier(id);
      if(targets.has(next))throw Error('short_chart_id_collision');
      targets.add(next);if(next!==id)renamed.push({id,next});
    }
    if(renamed.length) {
      sql.exec('PRAGMA defer_foreign_keys = ON');
      const chart=sql.prepare('UPDATE account_charts SET id = ? WHERE id = ?');
      const outcomes=sql.prepare("UPDATE chart_operation_outcomes SET outcome = json_set(outcome,'$.chartId',?) WHERE json_extract(outcome,'$.chartId') = ?");
      const issued=sql.prepare('UPDATE chart_identifiers SET id = ? WHERE id = ?');
      for(const {id,next} of renamed){chart.run(next,id);outcomes.run(next,id);issued.run(next,id);}
    }
    // The marker commits with the renames; a collision/crash leaves the migration retryable.
    mark.run('short_identifiers_v1');
  });
  const packages=createLibraryPackages(database);
  const preparation=createLibraryPreparationStorage(database);
  catalog=createLibraryCatalogStorage(database,returns);
  // Compile fixed SQL once per connection owner; each execution reads current rows.
  const statements = {
    identifier: sql.prepare('SELECT 1 FROM chart_identifiers WHERE id = ?'),
    reserve: sql.prepare('INSERT INTO chart_identifiers VALUES (?)'),
    own: sql.prepare('SELECT * FROM account_charts WHERE accountId = ? AND id = ?'),
    shared: sql.prepare('SELECT * FROM account_charts WHERE id = ?'),
    relatedReturn:sql.prepare(`SELECT r.chartId FROM account_charts c JOIN account_chart_returns r ON r.chartId=c.id
      WHERE json_extract(c.content,'$.source')='calculated' AND json_extract(c.content,'$.utc')=?
      AND COALESCE(NULLIF(json_extract(c.content,'$.timezone'),''),'UTC')=? AND c.id<>?
      AND r.action=? AND r.body=? AND r.eventUtc=? LIMIT 1`),
    matching: sql.prepare('SELECT * FROM account_charts WHERE accountId = ? AND nameKey = ? AND birthMinute = ?'),
    list: sql.prepare('SELECT * FROM account_charts WHERE accountId = ? ORDER BY id'),
    page: sql.prepare('SELECT * FROM account_charts WHERE accountId = ? AND id > ? ORDER BY id LIMIT ?'),
    insert: sql.prepare('INSERT INTO account_charts VALUES (?,?,?,?,?,?,?,?)'),
    update: sql.prepare(`UPDATE account_charts SET nameKey = ?, birthMinute = ?, revision = ?, noteRevision = ?, publicRevision = ?, content = ?
        WHERE accountId = ? AND id = ?`),
    remove: sql.prepare('DELETE FROM account_charts WHERE accountId = ? AND id = ?'),
    outcome: sql.prepare('SELECT createdAt, outcome FROM chart_operation_outcomes WHERE accountId = ? AND operationId = ?'),
    saveOutcome: sql.prepare('INSERT INTO chart_operation_outcomes VALUES (?,?,?,?)'),
    removeOutcome: sql.prepare('DELETE FROM chart_operation_outcomes WHERE accountId = ? AND operationId = ?'),
    cleanup: sql.prepare('DELETE FROM chart_operation_outcomes WHERE createdAt <= ?'),
  };
  return {
    packages,
    preparation,
    catalog,
    identifierUsed(id:string) { return Boolean(statements.identifier.get(id)); },
    get(accountId: string, id: string) {
      return decode(statements.own.get(accountId, id) as unknown as Row | undefined);
    },
    shared(id: string) { return decode(statements.shared.get(id) as unknown as Row | undefined); },
    match(accountId: string, nameKey: string, birthMinute: number) {
      return decode(statements.matching.get(accountId, nameKey, birthMinute) as unknown as Row | undefined);
    },
    list(accountId: string) {
      return (statements.list.all(accountId) as unknown as Row[])
        .map(row => decode(row)!);
    },
    page(accountId: string, after: string, limit: number) {
      return (statements.page.all(accountId, after, limit) as unknown as Row[]).map(row => decode(row)!);
    },
    insert(row: AccountChart, nameKey: string, birthMinute: number, content: AccountChartContent) {
      database.transaction(()=>{
        statements.reserve.run(row.id);
        statements.insert.run(row.id, row.accountId, nameKey, birthMinute, row.revision, row.noteRevision, row.publicRevision, JSON.stringify(content));
      });
    },
    update(row: AccountChart, nameKey: string, birthMinute: number, content: AccountChartContent) {
      return statements.update.run(nameKey, birthMinute, row.revision, row.noteRevision, row.publicRevision,
          JSON.stringify(content), row.accountId, row.id).changes === 1;
    },
    remove(accountId: string, id: string) {
      return statements.remove.run(accountId, id).changes === 1;
    },
    readReturn(chartId: string, action: 'events'|'chart', body: string, eventUtc: string): unknown {
      return returns.read({chartId,action,body,eventUtc});
    },
    readReturnFamily(chartId:string,body:string) {return returns.readFamily(chartId,body);},
    readRelatedReturn(chartId:string,birthUtc:string,timezone:string,action:'events'|'chart',body:string,eventUtc:string):unknown {
      const row=statements.relatedReturn.get(birthUtc,timezone,chartId,action,body,eventUtc) as {chartId:string}|undefined;
      return row?returns.read({chartId:row.chartId,action,body,eventUtc}):null;
    },
    saveReturn(chartId: string, action: 'events'|'chart', body: string, eventUtc: string, value: unknown) {
      returns.save({chartId,action,body,eventUtc},value);
    },
    clearReturns(chartId: string) { returns.clear(chartId); },
    outcome(accountId: string, operationId: string): ChartOutcomeRecord | null {
      const row = statements.outcome.get(accountId, operationId) as { createdAt: number; outcome: string } | undefined;
      return row ? {createdAt: row.createdAt, outcome: JSON.parse(row.outcome) as ChartWriteOutcome} : null;
    },
    saveOutcome(accountId: string, operationId: string, createdAt: number, outcome: ChartWriteOutcome) {
      statements.saveOutcome.run(accountId, operationId, createdAt, JSON.stringify(outcome));
    },
    removeOutcome(accountId: string, operationId: string) {
      statements.removeOutcome.run(accountId, operationId);
    },
    cleanup(beforeOrAt: number) { statements.cleanup.run(beforeOrAt); },
  };
}
