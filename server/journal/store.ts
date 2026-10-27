import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseJournalEvent, type JournalEvent } from './events.ts';
import { bufferReserve, canonicalJSON, journalPolicy, validReservedBytes, workspaceReserve,
  type JournalPolicy, type JournalResult, type JournalUsage } from './policy.ts';

interface IndexRow { id:string;hash:string;segment:string;offset:number;receivedAt:number }
interface RecordLine { event:JournalEvent;receivedAt:number;hash:string;bytes:Buffer;offset:number }
export interface JournalStoreOptions {directory:string;policy?:Partial<JournalPolicy>;externalReservedBytes?:number}
const segmentPattern=/^[0-9]{16}\.jsonl$/;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const eventJSON=(event:JournalEvent)=>canonicalJSON({...event});
const eventHash=(event:JournalEvent)=>{
  if(event.source!=='browser')return digest(eventJSON(event));
  const {deliveryIp,...report}=event;
  return digest(canonicalJSON(report));
};
// Browser clocks can be wrong or delivery delayed; their TTL begins at the first server receipt.
const retentionStart=(event:JournalEvent,receivedAt:number)=>event.source==='browser'
  ?receivedAt:Math.min(event.occurredAt,receivedAt);
const eventKey=(event:JournalEvent)=>`${event.source}:${event.eventId}`;
const corrupt=()=>new Error('Journal archive is corrupt');

/** Synchronous physical storage. Production calls it only from the dedicated journal worker. */
export function openJournalStore(options: JournalStoreOptions) {
  const policy=journalPolicy(options.policy), directory=path.resolve(options.directory);
  const created:string[]=[];
  for(let current=directory;!fs.existsSync(current);current=path.dirname(current))created.push(current);
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  for(const current of created) {
    const parentFd=fs.openSync(path.dirname(current),'r');
    try{fs.fsyncSync(parentFd);}finally{fs.closeSync(parentFd);}
  }
  const directoryFd=fs.openSync(directory,'r');
  let database:DatabaseSync;
  let closed=false, failed=false, externalBytes=options.externalReservedBytes??0;
  const filename=path.join(directory,'index.sqlite');
  const archive=()=>fs.readdirSync(directory).filter(name=>segmentPattern.test(name)).sort();
  const syncDirectory=()=>fs.fsyncSync(directoryFd);
  function diskBytes() {
    let total=0;
    for (const name of fs.readdirSync(directory)) {
      const stat=fs.lstatSync(path.join(directory,name));
      if (!stat.isFile()) throw new Error('Journal directory must contain only regular files');
      // Match the mail buffer: st_blocks uses 512-byte units, independently
      // of filesystem allocation size. Sparse files still owe their logical size.
      total+=Math.max(stat.size,stat.blocks*512);
    }
    return total;
  }
  function writeAll(fd:number,bytes:Buffer) {
    let position=0;
    while(position<bytes.length) {
      const written=fs.writeSync(fd,bytes,position,bytes.length-position);
      if(written===0)throw new Error('Journal write made no progress');
      position+=written;
    }
  }
  function decode(bytes:Buffer,offset:number):RecordLine {
    let value:unknown;
    try { value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { throw corrupt(); }
    if (!value || typeof value!=='object' || Array.isArray(value)) throw corrupt();
    const {receivedAt,checksum,...content}=value as Record<string,unknown>;
    const event=parseJournalEvent(content);
    if (!event || typeof receivedAt!=='number' || !Number.isSafeInteger(receivedAt) || receivedAt<0 || receivedAt>8.64e15
      || typeof checksum!=='string' || checksum!==digest(canonicalJSON({...event,receivedAt}))) throw corrupt();
    const payload=eventJSON(event);
    if(Buffer.byteLength(payload)>policy.maxEventBytes)throw corrupt();
    return {event,receivedAt,hash:eventHash(event),bytes,offset};
  }
  function* readSegment(name:string,truncateTail=false):Generator<RecordLine> {
    const fd=fs.openSync(path.join(directory,name),truncateTail?'r+':'r');
    const chunk=Buffer.alloc(16*1024);
    let remainder=Buffer.alloc(0), offset=0;
    try {
      let count:number;
      while((count=fs.readSync(fd,chunk,0,chunk.length,null))>0) {
        const data=Buffer.concat([remainder,chunk.subarray(0,count)]);
        let start=0, end:number;
        while((end=data.indexOf(10,start))!==-1) {
          const bytes=data.subarray(start,end+1);
          if(bytes.length>policy.maxEventBytes+256)throw corrupt();
          yield decode(bytes,offset);
          offset+=bytes.length;start=end+1;
        }
        remainder=Buffer.from(data.subarray(start));
        if(remainder.length>policy.maxEventBytes+256)throw corrupt();
      }
      if(remainder.length) {
        if(!truncateTail)throw corrupt();
        fs.ftruncateSync(fd,offset);
      }
      // A prior process may have died after write but before sync. Recovery completes durability before any ACK.
      if(truncateTail)fs.fsyncSync(fd);
    } finally {fs.closeSync(fd);}
  }
  function insert(record:RecordLine,segment:string,offset=record.offset) {
    database.prepare('INSERT INTO events(id,hash,segment,offset,receivedAt,expiresAt) VALUES (?,?,?,?,?,?)')
      .run(eventKey(record.event),record.hash,segment,offset,record.receivedAt,
        retentionStart(record.event,record.receivedAt)+policy.retentionMs);
  }
  function row(id:string):IndexRow|undefined {
    return database.prepare('SELECT id,hash,segment,offset,receivedAt FROM events WHERE id=?').get(id) as unknown as IndexRow|undefined;
  }
  function readRow(index:IndexRow):RecordLine {
    const fd=fs.openSync(path.join(directory,index.segment),'r');
    try {
      const bytes=Buffer.alloc(policy.maxEventBytes+256);
      const count=fs.readSync(fd,bytes,0,bytes.length,index.offset), end=bytes.subarray(0,count).indexOf(10);
      if(end<0)throw corrupt();
      const record=decode(bytes.subarray(0,end+1),index.offset);
      if(eventKey(record.event)!==index.id || record.hash!==index.hash || record.receivedAt!==index.receivedAt)throw corrupt();
      return record;
    } finally {fs.closeSync(fd);}
  }
  function replaceSegment(name:string,keep:(record:RecordLine)=>boolean) {
    // First decide whether replacement is needed; a clean segment creates no duplicate archive.
    let remove=false;
    for(const record of readSegment(name))if(!keep(record)){remove=true;break;}
    if(!remove)return;
    const temporary=path.join(directory,`${name}.tmp`);
    const fd=fs.openSync(temporary,'wx',0o600);
    let retained=0;
    try {
      for(const record of readSegment(name))if(keep(record)){writeAll(fd,record.bytes);retained+=record.bytes.length;}
      fs.fsyncSync(fd);
    } finally {fs.closeSync(fd);}
    if(retained)fs.renameSync(temporary,path.join(directory,name));
    else {fs.unlinkSync(path.join(directory,name));fs.unlinkSync(temporary);}
    syncDirectory();
    // An interruption anywhere above leaves an old index. No further reads occur until full recovery on reopen.
    database.prepare('DELETE FROM events WHERE segment=?').run(name);
    if(retained)for(const record of readSegment(name))insert(record,name);
  }
  function makeSpace(required:number) {
    while(diskBytes()+bufferReserve(policy)+externalBytes+workspaceReserve(policy)+required>policy.maxBytes) {
      // Only this bounded eviction batch lives in memory, never the archive's complete set of IDs.
      const oldest=database.prepare('SELECT id,segment FROM events ORDER BY receivedAt,segment,offset LIMIT 128')
        .all() as unknown as {id:string;segment:string}[];
      if(!oldest.length)return false;
      const victims=new Map<string,Set<string>>();
      for(const row of oldest) {
        if(!victims.has(row.segment))victims.set(row.segment,new Set());
        victims.get(row.segment)!.add(row.id);
      }
      for(const [segment,ids] of victims)replaceSegment(segment,record=>!ids.has(eventKey(record.event)));
    }
    return true;
  }
  function limitIndex() {
    // SQLite's page ceiling is logical. Keep any already allocated excess of
    // this index charged in `other` rather than granting that space twice.
    const other=diskBytes()-fs.statSync(filename).size;
    const pages=Math.floor((policy.maxBytes-bufferReserve(policy)-externalBytes-other-policy.segmentBytes)/4096);
    if(pages<6)throw new Error('Journal budget exhausted');
    const actual=database.prepare(`PRAGMA max_page_count=${pages}`).get()?.max_page_count;
    if(typeof actual!=='number' || actual>pages)throw new Error('Journal index exceeds its budget');
  }
  function initializeIndex() {
    // Defensive mode forbids journal_mode=OFF. Only this disposable, fully rebuilt index disables it.
    database=new DatabaseSync(filename,{timeout:0,defensive:false});
    fs.chmodSync(filename,0o600);
    database.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA locking_mode=EXCLUSIVE;
      PRAGMA cache_size=-64; PRAGMA mmap_size=0; PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON;
      PRAGMA auto_vacuum=FULL; BEGIN EXCLUSIVE; COMMIT;
      DROP TABLE IF EXISTS events;
      CREATE TABLE events(id TEXT PRIMARY KEY, hash TEXT NOT NULL, segment TEXT NOT NULL,
        offset INTEGER NOT NULL, receivedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL) STRICT, WITHOUT ROWID;
      CREATE INDEX events_received ON events(receivedAt,segment,offset);
      CREATE INDEX events_expiry ON events(expiresAt,segment);
      CREATE INDEX events_segment ON events(segment);`);
    if(database.prepare('PRAGMA journal_mode').get()?.journal_mode!=='off')throw new Error('Journal index must not create a second archive');
  }
  try {
    const initialIndexBytes=6*4096;
    const existingIndexBytes=fs.existsSync(filename)?fs.statSync(filename).size:0;
    if(!validReservedBytes(externalBytes) || bufferReserve(policy)+externalBytes+workspaceReserve(policy)+initialIndexBytes>policy.maxBytes
      || diskBytes()+bufferReserve(policy)+externalBytes+Math.max(0,initialIndexBytes-existingIndexBytes)>policy.maxBytes) {
      throw new Error('Journal reservation exceeds its budget');
    }
    // The index is disposable. A malformed SQLite file never makes the archive itself unrecoverable.
    try {
      initializeIndex();
    } catch(error) {
      database!?.close();
      const code=(error as {errcode?:number}).errcode;
      if(code!==11 && code!==26)throw error;
      fs.rmSync(filename,{force:true});initializeIndex();
    }
    for(const name of fs.readdirSync(directory))if(/^[0-9]{16}\.jsonl\.tmp$/.test(name))fs.unlinkSync(path.join(directory,name));
    limitIndex();
    const files=archive();
    for(const name of files) {
      for(const record of readSegment(name,name===files.at(-1)))insert(record,name);
      if(fs.statSync(path.join(directory,name)).size>policy.segmentBytes)throw corrupt();
      // Nonfinal segments also need durability when rebuilding an index after an interrupted rotation.
      const fd=fs.openSync(path.join(directory,name),'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }
    syncDirectory();
  } catch(error) {database!?.close();fs.closeSync(directoryFd);throw error;}
  return {
    append(input:JournalEvent,receivedAt:number,reservedBytes:number):JournalResult {
      if(closed || failed)return {status:'retryable',reason:'journal_unavailable'};
      const event=parseJournalEvent(input);
      if(!event || !Number.isSafeInteger(receivedAt) || receivedAt<0 || receivedAt>8.64e15)return {status:'invalid',reason:'invalid_event'};
      const payload=eventJSON(event);
      if(Buffer.byteLength(payload)>policy.maxEventBytes)return {status:'invalid',reason:'event_too_large'};
      if(!validReservedBytes(reservedBytes))return {status:'retryable',reason:'invalid_external_reservation'};
      externalBytes=reservedBytes;
      try {
        const existing=row(eventKey(event));
        if(existing) {
          const previous=readRow(existing);
          if(retentionStart(previous.event,previous.receivedAt)>receivedAt-policy.retentionMs) {
            return previous.hash===eventHash(event)?{status:'accepted',receivedAt:previous.receivedAt,duplicate:true}
              :{status:'conflict',reason:'event_id_conflict'};
          }
          replaceSegment(existing.segment,record=>eventKey(record.event)!==existing.id);
        }
        if(retentionStart(event,receivedAt)<=receivedAt-policy.retentionMs)return {status:'invalid',reason:'expired'};
        const checksum=digest(canonicalJSON({...event,receivedAt}));
        const bytes=Buffer.from(JSON.stringify({...event,receivedAt,checksum})+'\n');
        if(!makeSpace(bytes.length))return {status:'retryable',reason:'journal_full'};
        limitIndex();
        const files=archive();let segment=files.at(-1);
        let offset=segment?fs.statSync(path.join(directory,segment)).size:0;
        const fresh=!segment || offset+bytes.length>policy.segmentBytes;
        if(fresh){segment=String(Number(segment?.slice(0,16)??0)+1).padStart(16,'0')+'.jsonl';offset=0;}
        const fd=fs.openSync(path.join(directory,segment!),fresh?'wx':'a',0o600);
        try{writeAll(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        if(fresh)syncDirectory();
        insert({event,receivedAt,hash:eventHash(event),bytes,offset},segment!);
        return {status:'accepted',receivedAt,duplicate:false};
      } catch {failed=true;return {status:'retryable',reason:'journal_unavailable'};}
    },
    maintain(now:number,reservedBytes:number) {
      if(closed || failed)throw new Error('Journal unavailable');
      if(!Number.isSafeInteger(now) || !validReservedBytes(reservedBytes))throw new RangeError('Invalid journal maintenance input');
      externalBytes=reservedBytes;
      try {
        const next=()=>database.prepare('SELECT segment FROM events WHERE expiresAt<=? ORDER BY expiresAt LIMIT 1')
          .get(now) as {segment:string}|undefined;
        const expired=next();
        if(expired)replaceSegment(expired.segment,record=>retentionStart(record.event,record.receivedAt)>now-policy.retentionMs);
        if(!makeSpace(0))throw new Error('Journal reservation exceeds its budget');
        return {more:!!next()};
      } catch(error){failed=true;throw error;}
    },
    usage():JournalUsage {return {diskBytes:diskBytes(),bufferReservedBytes:bufferReserve(policy),externalBytes};},
    close() {if(closed)return;closed=true;database.close();fs.closeSync(directoryFd);},
  };
}
