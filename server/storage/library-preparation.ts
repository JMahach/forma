import type {Database} from './database.ts';
import type {AccountChart} from '../../shared/chart-record-contract.ts';

export interface LibraryPreparation {
  chartId:string; accountId:string; sourceKey:string; recordRevision:number; attempts:number; retryAfter:number;
}
export const preparationSource=(chart:Pick<AccountChart,'birthDate'|'timezone'|'utc'>)=>JSON.stringify([chart.birthDate,chart.timezone,chart.utc]);

/** Only unfinished destinations. Prepared parts themselves are the durable progress record. */
export function createLibraryPreparationStorage(database:Database) {
  const sql=database.connection;
  sql.exec(`CREATE TABLE IF NOT EXISTS library_preparations (
    chartId TEXT PRIMARY KEY REFERENCES account_charts(id) ON DELETE CASCADE ON UPDATE CASCADE,
    sourceKey TEXT NOT NULL, recordRevision INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, retryAfter INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX IF NOT EXISTS library_preparation_due ON library_preparations(retryAfter,chartId);`);
  database.transaction(()=>{
    if(sql.prepare("SELECT 1 FROM chart_storage_migrations WHERE name='library_preparation'").get())return;
    sql.exec(`INSERT INTO library_preparations(chartId,sourceKey,recordRevision)
      SELECT id,json_array(json_extract(content,'$.birthDate'),json_extract(content,'$.timezone'),json_extract(content,'$.utc')),revision
      FROM account_charts WHERE json_extract(content,'$.source')='calculated';`);
    sql.prepare("INSERT INTO chart_storage_migrations VALUES ('library_preparation')").run();
  });
  const next=sql.prepare(`SELECT p.*,CAST(c.accountId AS TEXT) AS accountId FROM library_preparations p
    JOIN account_charts c ON c.id=p.chartId WHERE retryAfter<=? ORDER BY retryAfter,chartId LIMIT 1`);
  const due=sql.prepare('SELECT MIN(retryAfter) AS time FROM library_preparations');
  const reset=sql.prepare(`INSERT INTO library_preparations VALUES(?,?,?,0,0)
    ON CONFLICT(chartId) DO UPDATE SET sourceKey=excluded.sourceKey,recordRevision=excluded.recordRevision,attempts=0,retryAfter=0`);
  const remove=sql.prepare('DELETE FROM library_preparations WHERE chartId=?');
  const complete=sql.prepare('DELETE FROM library_preparations WHERE chartId=? AND sourceKey=? AND recordRevision=?');
  const postpone=sql.prepare(`UPDATE library_preparations SET attempts=attempts+1,retryAfter=?
    WHERE chartId=? AND sourceKey=? AND recordRevision=?`);
  return {
    reset(chart:AccountChart) {
      if(chart.source==='calculated')reset.run(chart.id,preparationSource(chart),chart.revision);
      else remove.run(chart.id);
    },
    next(time:number):LibraryPreparation|null {return next.get(time) as unknown as LibraryPreparation|undefined??null;},
    nextDue():number|null {return (due.get() as {time:number|null}).time;},
    complete(task:LibraryPreparation) {return complete.run(task.chartId,task.sourceKey,task.recordRevision).changes===1;},
    postpone(task:LibraryPreparation,time:number) {return postpone.run(time,task.chartId,task.sourceKey,task.recordRevision).changes===1;},
  };
}
