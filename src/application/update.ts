export interface UpdatePort {
  restored():boolean;
  ready():boolean;
  selection():string;
  canRestore(id:string):boolean|Promise<boolean>;
  checkpoint():boolean;
}

/** Durability belongs to storage; the application revalidates intent before committing. */
export function prepareUpdate(port:UpdatePort,ready:()=>boolean):boolean|Promise<boolean> {
  if(!ready())return false;
  const selected=port.selection();
  const finish=()=>selected===port.selection() && ready() && port.checkpoint();
  const durable=port.canRestore(selected);
  return typeof durable==='boolean'?durable && finish():durable.then(value=>value && finish(),()=>false);
}
