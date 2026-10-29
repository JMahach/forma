import fs from 'node:fs';
import path from 'node:path';

const segmentPattern=/^[0-9]{16}\.jsonl$/;
interface FileSize {size:number;allocated:number}

/** The journal worker owns mutations. Keep file metadata, never event payloads. */
export class ArchiveCatalog {
  private directory:string;
  private files=new Map<string,FileSize>();
  private otherFiles=new Set<string>();
  private segmentNames:string[]=[];
  private total=0;
  private stamp='';

  constructor(directory:string) {
    this.directory=directory;
    this.discover();
  }

  private directoryStamp() {
    const stat=fs.statSync(this.directory,{bigint:true});
    return `${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }

  private measure(name:string):FileSize|undefined {
    try {
      const stat=fs.lstatSync(path.join(this.directory,name));
      if(!stat.isFile())throw new Error('Journal directory must contain only regular files');
      // Charge both allocated blocks and the logical length of sparse files.
      return {size:stat.size,allocated:Math.max(stat.size,stat.blocks*512)};
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;
      throw error;
    }
  }

  private refresh(name:string) {
    const previous=this.files.get(name),current=this.measure(name);
    this.total+=(current?.allocated??0)-(previous?.allocated??0);
    if(current)this.files.set(name,current);
    else this.files.delete(name);
    if(segmentPattern.test(name)) {
      if(Boolean(current)!==Boolean(previous)) {
        this.segmentNames=current?[...this.segmentNames,name].sort():this.segmentNames.filter(value=>value!==name);
      }
    } else {
      if(current)this.otherFiles.add(name);
      else this.otherFiles.delete(name);
    }
  }

  private discover() {
    this.files.clear();this.otherFiles.clear();this.segmentNames=[];this.total=0;
    for(const name of fs.readdirSync(this.directory))this.refresh(name);
    this.stamp=this.directoryStamp();
  }

  names() {return [...this.files.keys()];}
  segments() {return [...this.segmentNames];}
  lastSegment() {
    const name=this.segmentNames.at(-1);
    return name?{name,size:this.files.get(name)!.size}:null;
  }

  changed(...names:string[]) {
    for(const name of names)this.refresh(name);
    this.stamp=this.directoryStamp();
  }

  bytes() {
    // Unexpected additions/removals remain charged. Normal owned mutations update the catalogue directly.
    if(this.directoryStamp()!==this.stamp)this.discover();
    // SQLite may allocate/shrink pages during index updates. Nonarchive files also remain fully charged.
    for(const name of this.otherFiles)this.refresh(name);
    const active=this.segmentNames.at(-1);
    if(active)this.refresh(active);
    return this.total;
  }
}
