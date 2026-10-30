import path from 'node:path';
/** Writer ownership is explicit; an unavailable external service never selects embedded mode. */
export function journalWriterMode(env:NodeJS.ProcessEnv):'embedded'|'external' {
 const mode=env.FORMA_JOURNAL_WRITER;
 if(mode!=='embedded' && mode!=='external')throw new TypeError('FORMA_JOURNAL_WRITER must be embedded or external');
 return mode;
}
/** A separate journal zone; local release-bundle checks are still a stand. */
export function journalEnvironment(env:NodeJS.ProcessEnv,stateDir:string): {directory:string; environment:'stand'|'production'} {
 const directory=env.FORMA_JOURNAL_DIR ?? path.join(stateDir,'journal');
 const environment=env.FORMA_ENVIRONMENT ?? 'stand';
 if(environment!=='stand' && environment!=='production')throw new TypeError('FORMA_ENVIRONMENT must be stand or production');
 const target=path.resolve(directory),accounts=path.resolve(stateDir);
 const overlaps=['archive','mail-pending'].some(name=>{
  const relative=path.relative(path.join(target,name),accounts);
  return relative==='' || !path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep);
 });
 if(!path.isAbsolute(directory) || target===path.parse(target).root || target===accounts || overlaps) {
  throw new TypeError('FORMA_JOURNAL_DIR must name a separate absolute directory');
 }
 return{directory,environment};
}
