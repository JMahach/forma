#!/usr/bin/env node
// Reads product files and import evidence; writes reports only to the given audit output.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

import { tarjan } from './graph.mjs';
export { tarjan } from './graph.mjs';

export function externalImportAllowed(edge, owner, policy) {
 if (!policy) return true;
 if (edge.specifier?.startsWith('node:')) return policy.nodeBuiltinsAllowedFrom.includes(owner);
 return (policy.packages || []).some(entry => entry.owner === owner && entry.from === edge.from
  && entry.specifier === edge.specifier && Boolean(entry.reason));
}

export function checkContour({modules,files,imports,exceptions=[],valueContracts=[],assets=[],externalPolicy=null,contour='typescript'}) {
 const violations=[], appliedExceptions=[], appliedValueContracts=[];
 const moduleMap=new Map(),owners=new Map();
 const record=(code,details)=>violations.push({code,contour,...details});
 for(const m of modules){
  if(moduleMap.has(m.id))record('duplicate_module',{module:m.id});moduleMap.set(m.id,m);
  for(const file of m.files){const list=owners.get(file)||[];list.push(m.id);owners.set(file,list);}
 }
 const actual=new Set(files);
 for(const file of files){const owner=owners.get(file)||[];if(!owner.length)record('unknown_file',{file});else if(owner.length!==1)record('duplicate_owner',{file,owners:owner});}
 for(const [file,owner]of owners){if(!actual.has(file))record('declared_file_missing',{file,owners:owner});if(owner.length!==1&&!actual.has(file))record('duplicate_owner',{file,owners:owner});}
 for(const m of modules){
  for(const file of m.publicEntries)if(!m.files.includes(file))record('invalid_public_entry',{file,module:m.id});
  for(const file of m.executionEntries||[])if(!m.files.includes(file))record('invalid_execution_entry',{file,module:m.id});
  for(const mode of ['allowRuntime','allowTypes'])for(const target of m[mode]||[])if(!moduleMap.has(target))record('unknown_allowed_module',{module:m.id,target,mode});
 }
 const owner=file=>owners.get(file)?.length===1?owners.get(file)[0]:null;
 const assetsByFile=new Map(assets.map(a=>[a.file,a]));
 for(const ex of exceptions){
  if(!owner(ex.from)||!owner(ex.to)||!ex.reason||/[?*]/.test(ex.from+ex.to)||!ex.modes?.length)record('invalid_exact_exception',{exception:ex});
 }
 for(const contract of valueContracts){
  if(!owner(contract.from)||!owner(contract.to)||contract.mode!=='types'||contract.kind!=='import-declaration'||contract.status!=='stable-value-contract'||!contract.reason||!Array.isArray(contract.importedBindings)||!contract.importedBindings.length||contract.importedBindings.some(n=>typeof n!=='string'||!/^[A-Za-z_$][\w$]*$/.test(n))||new Set(contract.importedBindings).size!==contract.importedBindings.length)record('invalid_value_contract',{contract});
 }
 const graphRows=[];
 for(const edge of imports){
  const from=owner(edge.from);if(!from)continue;
  const modes=edge.typeOnly?['types']:['runtime',...(edge.bindings?.some(b=>b.typeOnly)?['types']:[])];
  if(edge.resolution==='external'){
   if(!externalImportAllowed(edge,from,externalPolicy))record('unclassified_external_dependency',{...edge,fromModule:from});
   continue;
  }
  if(!['internal','asset'].includes(edge.resolution)){
   if(edge.resolution!=='namespace')record('unresolved_or_out_of_scope_import',{...edge,fromModule:from});continue;
  }
  const asset=edge.resolution==='asset'?assetsByFile.get(edge.to):null;
  const to=asset?.owner||owner(edge.to);
  if(!to){record(edge.resolution==='asset'?'undeclared_asset':'target_without_unique_owner',{...edge,fromModule:from});continue;}
  for(const mode of modes){
   if(from!==to)graphRows.push({from,to,mode,evidence:{from:edge.from,to:edge.to,line:edge.line,kind:edge.kind}});
   const exact=exceptions.find(x=>x.from===edge.from&&x.to===edge.to&&x.modes.includes(mode));
   if(exact)appliedExceptions.push({from:edge.from,to:edge.to,line:edge.line,mode,reason:exact.reason});
   const valueContract=mode==='types'&&edge.typeOnly===true&&edge.runtime===false&&edge.bindings?.length>0&&edge.bindings.every(b=>b.typeOnly===true&&typeof b.importedName==='string')
    ? valueContracts.find(c=>c.from===edge.from&&c.to===edge.to&&c.mode==='types'&&c.kind===edge.kind&&edge.bindings.every(b=>c.importedBindings.includes(b.importedName))) : null;
   if(valueContract)appliedValueContracts.push({id:valueContract.id,from:edge.from,to:edge.to,line:edge.line,mode,importedBindings:edge.bindings.map(b=>b.importedName),reason:valueContract.reason});
   const allowed=moduleMap.get(from)[mode==='runtime'?'allowRuntime':'allowTypes']||[];
   if(!allowed.includes(to)&&!exact?.bypass?.includes('allowlist')&&!valueContract)record('forbidden_import',{...edge,mode,fromModule:from,toModule:to,allowed});
   if(from!==to&&!(asset?asset.public:moduleMap.get(to)?.publicEntries.includes(edge.to))&&!exact?.bypass?.includes('public-entry'))record('private_entry',{...edge,mode,fromModule:from,toModule:to});
  }
 }
 function graph(runtimeOnly){
  const rows=graphRows.filter(e=>!runtimeOnly||e.mode==='runtime');
  const edges=[...new Set(rows.map(e=>JSON.stringify([e.from,e.to])))].map(v=>JSON.parse(v));
  const result=tarjan([...moduleMap.keys()],edges);
  return {vertexCount:moduleMap.size,edgeCount:edges.length,edges,...result,cycleEvidence:result.cyclicScc.map(c=>({modules:c,edges:rows.filter(e=>c.includes(e.from)&&c.includes(e.to))}))};
 }
 const graphs={runtime:graph(true),full:graph(false)};
 const fileGraphs={};
 for(const scope of ['runtime','full']) {
  const edges=imports.filter(e=>e.resolution==='internal'&&actual.has(e.from)&&actual.has(e.to)&&(scope==='full'||e.runtime));
  const result=tarjan(files,edges.map(e=>[e.from,e.to]));
  fileGraphs[scope]=result;
  for(const cycle of result.cyclicScc)record('file_cycle',{scope,files:cycle,evidence:edges.filter(e=>cycle.includes(e.from)&&cycle.includes(e.to))});
 }

 function declaredGraph(runtimeOnly){
  const pairs=[];
  for(const m of modules)for(const to of runtimeOnly?m.allowRuntime:[...m.allowRuntime,...m.allowTypes])if(to!==m.id&&moduleMap.has(to))pairs.push([m.id,to]);
  for(const ex of exceptions)if(!runtimeOnly||ex.modes.includes('runtime')){const from=owner(ex.from),to=owner(ex.to);if(from&&to&&from!==to)pairs.push([from,to]);}
  if(!runtimeOnly)for(const c of valueContracts){const from=owner(c.from),to=owner(c.to);if(from&&to&&from!==to)pairs.push([from,to]);}
  const edges=[...new Set(pairs.map(e=>JSON.stringify(e)))].map(e=>JSON.parse(e));
  return {edges,...tarjan([...moduleMap.keys()],edges)};
 }
 const declaredGraphs={runtime:declaredGraph(true),full:declaredGraph(false)};
 for(const scope of ['runtime','full'])for(const c of declaredGraphs[scope].cyclicScc)record('declaration_module_cycle',{scope,modules:c});
 for(const scope of ['runtime','full'])for(const c of graphs[scope].cyclicScc)record('module_cycle',{scope,modules:c});
 return {contour,files:files.length,modules:modules.length,uniquelyOwnedFiles:files.filter(f=>owners.get(f)?.length===1).length,violations,appliedExceptions,appliedValueContracts,graphs,fileGraphs,declaredGraphs};
}

export function evidenceIssues(source={},python={}){
 const issues=[];
 for(const item of source.untraceableDynamicImports||[])issues.push({code:'untraceable_dynamic_import',contour:'typescript',...item});
 for(const file of source.missingAst||[])issues.push({code:'missing_ast',contour:'typescript',file});
 for(const item of source.syntaxDiagnostics||[])issues.push({code:'syntax_diagnostic',contour:'typescript',diagnostic:item});
 for(const file of source.changedDuringRead||[])issues.push({code:'source_changed_during_collection',contour:'typescript',file});
 for(const item of python.parseErrors||[])issues.push({code:'parse_error',contour:'python',detail:item});
 for(const file of python.sourceFilesChangedDuringRead||[])issues.push({code:'source_changed_during_collection',contour:'python',file});
 for(const item of python.dynamicImports||[])if(!['internal','external','namespace'].includes(item.classification))issues.push({code:'untraceable_dynamic_import',contour:'python',...item});
 return issues;
}

function controls(){
 const module=(id,files,publicEntries,allowed=[])=>({id,files,publicEntries,allowRuntime:[id,...allowed],allowTypes:[id,...allowed]});
 const edge=(from,to)=>({from,to,line:1,kind:'control-import',typeOnly:false,runtime:true,resolution:'internal'});
 const evidenceControl=evidenceIssues({untraceableDynamicImports:[{from:'a.ts',line:1,expression:'variable'}],missingAst:['b.ts'],syntaxDiagnostics:[{file:'c.ts',message:'bad syntax'}]}, {parseErrors:[{path:'a.py'}],dynamicImports:[{source:'b.py',classification:'untraceable_dynamic'}]});
 assert.equal(evidenceControl.length,5);
 const base={modules:[module('a',['a.ts'],['a.ts'],['b']),module('b',['b.ts'],['b.ts'])],files:['a.ts','b.ts'],imports:[edge('a.ts','b.ts')]};
 const tests=[{name:'incomplete-graph-evidence-is-not-green',actual:evidenceControl.map(v=>v.code),passed:true}];
 function run(name,input,expected){const result=checkContour(input);for(const code of expected)assert.ok(result.violations.some(v=>v.code===code),name+': '+code);tests.push({name,expected,actual:result.violations.map(v=>v.code),passed:true});}
 const good=checkContour(base);assert.equal(good.violations.length,0);tests.push({name:'valid-declared-DAG',passed:true});
 run('unknown-file',{...base,files:[...base.files,'new.ts']},['unknown_file']);
 run('duplicate-owner',{...base,modules:[...base.modules,module('c',['a.ts'],[])]},['duplicate_owner']);
 run('forbidden-runtime-import',{...base,modules:[module('a',['a.ts'],['a.ts']),base.modules[1]]},['forbidden_import']);
 run('forbidden-type-import',{...base,modules:[{...base.modules[0],allowTypes:['a']},base.modules[1]],imports:[{...base.imports[0],typeOnly:true,runtime:false}]},['forbidden_import']);
 run('private-entry',{...base,modules:[base.modules[0],module('b',['b.ts'],[])]},['private_entry']);
 const contract={id:'control-value',from:'a.ts',to:'b.ts',mode:'types',kind:'import-declaration',status:'stable-value-contract',importedBindings:['Allowed'],reason:'Exact stable value contract control'};
 const named={from:'a.ts',to:'b.ts',line:1,kind:'import-declaration',typeOnly:true,runtime:false,resolution:'internal',bindings:[{name:'Alias',localName:'Alias',importedName:'Allowed',typeOnly:true}]};
 const restricted={...base,modules:[module('a',['a.ts'],['a.ts']),base.modules[1]],imports:[named],valueContracts:[contract]};
 const granted=checkContour(restricted);assert.equal(granted.violations.length,0);assert.equal(granted.appliedValueContracts.length,1);tests.push({name:'named-value-contract-allows-imported-name-with-alias',passed:true});
 run('named-value-contract-denies-other-type-despite-local-alias',{...restricted,imports:[{...named,bindings:[{name:'Allowed',importedName:'OtherController',typeOnly:true}]}]},['forbidden_import']);
 run('named-value-contract-denies-runtime-same-pair',{...restricted,imports:[{...named,typeOnly:false,runtime:true,bindings:[{name:'Allowed',importedName:'Allowed',typeOnly:false}]}]},['forbidden_import']);
 run('named-value-contract-denies-mixed-extra-type',{...restricted,imports:[{...named,bindings:[...named.bindings,{name:'Other',importedName:'Other',typeOnly:true}]}]},['forbidden_import']);
 run('named-value-contract-denies-missing-binding-evidence',{...restricted,imports:[{...named,bindings:[]}]},['forbidden_import']);
 run('module-cycle',{...base,modules:[base.modules[0],module('b',['b.ts'],['b.ts'],['a'])],imports:[...base.imports,edge('b.ts','a.ts')]},['module_cycle']);
 return tests;
}
function collectDiskFiles(root,extensions,excluded,roots){
 const files=[],symlinks=[];function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);const rel=path.relative(root,file).split(path.sep).join('/');if(item.isSymbolicLink()){symlinks.push(rel);continue;}if(item.isDirectory()&&!excluded.includes(item.name))walk(file);else if(item.isFile()&&extensions.some(ext=>item.name.endsWith(ext)))files.push(rel);}}
 for(const name of roots){const directory=path.join(root,name);if(fs.existsSync(directory))walk(directory);}return {files:files.sort(),symlinks};
}
export function main(argv=process.argv.slice(2)){
 const base=path.dirname(fileURLToPath(import.meta.url));
 const policyPath=path.resolve(argv[0]||path.join(base,'architecture-boundaries.json'));
 const graphPath=path.resolve(argv[1]||path.join(base,'typescript-import-graph.json'));
 const outputPath=path.resolve(argv[2]||path.join(base,'boundary-check-result.json'));
 const pythonPath=path.resolve(argv[3]||path.join(base,'python-import-graph.json'));
 const policy=JSON.parse(fs.readFileSync(policyPath,'utf8')),source=JSON.parse(fs.readFileSync(graphPath,'utf8')),python=JSON.parse(fs.readFileSync(pythonPath,'utf8'));
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 const integrity=evidenceIssues(source,python);
 const disk=collectDiskFiles(source.root,policy.scope.codeExtensions,policy.scope.excludedDirectories,policy.scope.roots);
 const graphFiles=new Set(source.nodes.map(n=>n.file));
 for(const f of disk.files)if(!graphFiles.has(f))integrity.push({code:'graph_missing_live_file',file:f});
 for(const n of source.nodes){const p=path.join(source.root,n.file);if(!fs.existsSync(p))integrity.push({code:'graph_file_deleted',file:n.file});else if(digest(fs.readFileSync(p))!==n.sha256)integrity.push({code:'graph_file_changed',file:n.file});}
 for(const n of python.files){const p=path.join(source.root,n.path);if(!fs.existsSync(p))integrity.push({code:'python_graph_file_deleted',file:n.path});else if(digest(fs.readFileSync(p))!==n.sha256)integrity.push({code:'python_graph_file_changed',file:n.path});}
 for(const f of disk.symlinks)integrity.push({code:'uninspected_symlink',file:f});
 const ts=checkContour({modules:policy.modules,files:disk.files,imports:source.imports,exceptions:policy.exactExceptions,valueContracts:policy.stableValueContracts||[],assets:policy.assets,externalPolicy:policy.externalPolicy});
 const pyDisk=collectDiskFiles(source.root,['.py'],[...policy.scope.excludedDirectories,'.venv','__pycache__'],policy.scope.roots);
 const pyGraphFiles=new Set(python.files.map(f=>f.path));for(const f of pyDisk.files)if(!pyGraphFiles.has(f))integrity.push({code:'python_graph_missing_live_file',file:f});
 const pyImports=[...python.imports,...(python.dynamicImports||[]).filter(e=>['internal','external','namespace'].includes(e.classification))].map(e=>({from:e.source,to:e.target,line:e.line,column:e.column,kind:e.kind,specifier:e.module||e.literal,typeOnly:false,runtime:true,resolution:e.classification==='internal'?'internal':e.classification==='external'?'external':e.classification==='namespace'?'namespace':'unresolved',resolutionMethod:e.resolution}));
 const py=checkContour({modules:policy.python.modules,files:pyDisk.files,imports:pyImports,contour:'python'});
 const fileCycleFindings=[...ts.violations,...py.violations].filter(v=>v.code==='file_cycle');
 const unitControls=controls();
 const violations=[...integrity,...ts.violations,...py.violations];
 const counts=Object.fromEntries([...new Set(violations.map(v=>v.code))].sort().map(code=>[code,violations.filter(v=>v.code===code).length]));
 const result={schemaVersion:1,createdAt:new Date().toISOString(),status:violations.length?'DEVIATIONS_FOUND':'MATCHES_PROPOSED_DECLARATION',policyStatus:policy.status,policyRevision:policy.revision,policyPath,policySha256:digest(fs.readFileSync(policyPath)),sourceGraphPath:graphPath,sourceGraphSha256:digest(fs.readFileSync(graphPath)),root:source.root,sourceSnapshotHash:source.sourceSnapshotHash,sourceGit:source.git,integrity,summary:{typescriptFiles:ts.files,typescriptModules:ts.modules,typescriptUniquelyOwnedFiles:ts.uniquelyOwnedFiles,appliedStableValueContracts:ts.appliedValueContracts.length,pythonFiles:py.files,pythonModules:py.modules,violations:violations.length,counts,runtimeModuleCycles:ts.graphs.runtime.cyclicScc.length,fullModuleCycles:ts.graphs.full.cyclicScc.length,pythonModuleCycles:py.graphs.full.cyclicScc.length,declaredRuntimeModuleCycles:ts.declaredGraphs.runtime.cyclicScc.length,declaredFullModuleCycles:ts.declaredGraphs.full.cyclicScc.length,controlsPassed:unitControls.every(t=>t.passed)},typescript:ts,python:py,fileCycleFindings,controls:unitControls,limitations:policy.limits,violations};
 fs.writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n');
 fs.writeFileSync(path.join(path.dirname(outputPath),'boundary-check-controls.json'),JSON.stringify(unitControls,null,2)+'\n');
 console.log(JSON.stringify({status:result.status,...result.summary},null,2));
 return violations.length?1:0;
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url)))process.exitCode=main();
