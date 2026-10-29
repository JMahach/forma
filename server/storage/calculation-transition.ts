import type { Database } from './database.ts';
import { migrateCalculationMetadata } from '../../shared/calculation-storage-transition.ts';

function content(text:string, nestedChart:boolean):string {
  const original:Record<string, unknown> & {engine?:string} = JSON.parse(text);
  let migrated = migrateCalculationMetadata(original);
  if (nestedChart && Object.hasOwn(original, 'chart')) {
    const next = migrateCalculationMetadata(original.chart as {engine?:string});
    if (next !== original.chart) migrated = {...migrated, chart:next};
  }
  return migrated === original ? text : JSON.stringify(migrated);
}

/** One explicit schema transition, never called by normal reads. Rollback keeps
 * both old contracts and all records intact; restart safely repeats the work.
 * The storage owner runs it before compiling the unversioned reader/writer. */
export function migrateStoredCalculations(database:Database) {
  return database.transaction(() => {
    const sql = database.connection;
    const columns = sql.prepare('PRAGMA table_info(account_chart_returns)').all() as {name:string}[];
    const obsolete = columns.filter(({name}) => name === 'calculationVersion' || name === 'cyclesVersion');
    if (!obsolete.length) return false;
    const chart = sql.prepare('UPDATE account_charts SET content=? WHERE id=?');
    for (const row of sql.prepare('SELECT id,content FROM account_charts').iterate() as Iterable<{id:string;content:string}>) {
      const next = content(row.content, false);
      if (next !== row.content) chart.run(next, row.id);
    }
    const returns = sql.prepare('UPDATE account_chart_returns SET content=? WHERE chartId=? AND action=? AND body=? AND eventUtc=?');
    for (const row of sql.prepare('SELECT chartId,action,body,eventUtc,content FROM account_chart_returns').iterate() as Iterable<{
      chartId:string;action:string;body:string;eventUtc:string;content:string;
    }>) {
      const next = content(row.content, true);
      if (next !== row.content) returns.run(next, row.chartId, row.action, row.body, row.eventUtc);
    }
    sql.exec('DROP INDEX IF EXISTS account_chart_returns_versions');
    for (const {name} of obsolete) sql.exec(`ALTER TABLE account_chart_returns DROP COLUMN ${name}`);
    return true;
  });
}
