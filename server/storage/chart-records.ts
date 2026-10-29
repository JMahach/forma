import { migrateStoredCalculations } from './calculation-transition.ts';
import {createLibraryPackages} from './library-packages.ts';
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
  CREATE TABLE IF NOT EXISTS account_chart_returns (
    chartId TEXT NOT NULL REFERENCES account_charts(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK(action IN ('events','chart')),
    body TEXT NOT NULL, eventUtc TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY(chartId, action, body, eventUtc),
    CHECK((action = 'events' AND eventUtc = '') OR (action = 'chart' AND length(eventUtc) > 0))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS chart_operation_outcomes (
    accountId INTEGER NOT NULL REFERENCES accounts(id), operationId TEXT NOT NULL,
    createdAt INTEGER NOT NULL, outcome TEXT NOT NULL,
    PRIMARY KEY(accountId, operationId)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS chart_operation_expiry ON chart_operation_outcomes(createdAt);`);
  migrateStoredCalculations(database);
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
      const returns=sql.prepare('UPDATE account_chart_returns SET chartId = ? WHERE chartId = ?');
      const outcomes=sql.prepare("UPDATE chart_operation_outcomes SET outcome = json_set(outcome,'$.chartId',?) WHERE json_extract(outcome,'$.chartId') = ?");
      const issued=sql.prepare('UPDATE chart_identifiers SET id = ? WHERE id = ?');
      for(const {id,next} of renamed){chart.run(next,id);returns.run(next,id);outcomes.run(next,id);issued.run(next,id);}
    }
    // The marker commits with the renames; a collision/crash leaves the migration retryable.
    mark.run('short_identifiers_v1');
  });
  const packages=createLibraryPackages(database);
  // Compile fixed SQL once per connection owner; each execution reads current rows.
  const statements = {
    identifier: sql.prepare('SELECT 1 FROM chart_identifiers WHERE id = ?'),
    reserve: sql.prepare('INSERT INTO chart_identifiers VALUES (?)'),
    own: sql.prepare('SELECT * FROM account_charts WHERE accountId = ? AND id = ?'),
    shared: sql.prepare('SELECT * FROM account_charts WHERE id = ?'),
    matching: sql.prepare('SELECT * FROM account_charts WHERE accountId = ? AND nameKey = ? AND birthMinute = ?'),
    list: sql.prepare('SELECT * FROM account_charts WHERE accountId = ? ORDER BY id'),
    page: sql.prepare('SELECT * FROM account_charts WHERE accountId = ? AND id > ? ORDER BY id LIMIT ?'),
    insert: sql.prepare('INSERT INTO account_charts VALUES (?,?,?,?,?,?,?,?)'),
    update: sql.prepare(`UPDATE account_charts SET nameKey = ?, birthMinute = ?, revision = ?, noteRevision = ?, publicRevision = ?, content = ?
        WHERE accountId = ? AND id = ?`),
    remove: sql.prepare('DELETE FROM account_charts WHERE accountId = ? AND id = ?'),
    readReturn: sql.prepare(`SELECT content FROM account_chart_returns
        WHERE chartId = ? AND action = ? AND body = ? AND eventUtc = ?`),
    saveReturn: sql.prepare(`INSERT INTO account_chart_returns VALUES (?,?,?,?,?)
        ON CONFLICT(chartId,action,body,eventUtc) DO UPDATE SET content=excluded.content
        WHERE account_chart_returns.content IS NOT excluded.content`),
    clearReturns: sql.prepare('DELETE FROM account_chart_returns WHERE chartId = ?'),
    outcome: sql.prepare('SELECT createdAt, outcome FROM chart_operation_outcomes WHERE accountId = ? AND operationId = ?'),
    saveOutcome: sql.prepare('INSERT INTO chart_operation_outcomes VALUES (?,?,?,?)'),
    removeOutcome: sql.prepare('DELETE FROM chart_operation_outcomes WHERE accountId = ? AND operationId = ?'),
    cleanup: sql.prepare('DELETE FROM chart_operation_outcomes WHERE createdAt <= ?'),
  };
  return {
    packages,
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
    readReturn(chartId: string, action: string, body: string, eventUtc: string): unknown {
      const row=statements.readReturn.get(chartId,action,body,eventUtc) as {content:string}|undefined;
      try { return row ? JSON.parse(row.content) : null; } catch { return null; }
    },
    saveReturn(chartId: string, action: string, body: string, eventUtc: string, value: unknown) {
      statements.saveReturn.run(chartId,action,body,eventUtc,JSON.stringify(value));
    },
    clearReturns(chartId: string) { statements.clearReturns.run(chartId); },
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
