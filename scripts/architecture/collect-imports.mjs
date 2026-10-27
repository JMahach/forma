#!/usr/bin/env node
// Read-only product inspection. Only the chosen output directory is written.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

import { tarjan } from './graph.mjs';

export async function collectImports(requestedRoot, outputDirectory) {
const root = fs.realpathSync(requestedRoot);
const out = path.resolve(outputDirectory);
fs.mkdirSync(out, { recursive: true });
const compilerDir = path.join(root, 'node_modules/typescript');
const compilerPackage = JSON.parse(fs.readFileSync(path.join(compilerDir, 'package.json'), 'utf8'));
const { API } = await import(pathToFileURL(path.join(compilerDir, 'dist/api/sync/api.js')));
const ts = await import(pathToFileURL(path.join(compilerDir, 'dist/ast/index.js')));
const scope = JSON.parse(fs.readFileSync(new URL('./architecture-boundaries.json', import.meta.url), 'utf8')).scope;
const includedRoots = scope.roots;
const excludes = new Set(scope.excludedDirectories);
const sourcePattern = /\.(?:[cm]?[jt]sx?)$/i;
const rel = file => path.relative(root, file).split(path.sep).join('/');
const sha = text => createHash('sha256').update(text).digest('hex');
const files = [], skippedSymlinks = [];
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
    const file = path.join(dir, item.name);
    if (item.isSymbolicLink()) { skippedSymlinks.push(rel(file)); continue; }
    if (item.isDirectory() && !excludes.has(item.name)) walk(file);
    else if (item.isFile() && sourcePattern.test(item.name)) files.push(file);
  }
}
includedRoots.forEach(p => { const directory = path.join(root, p); if (fs.existsSync(directory)) walk(directory); });
files.sort();
const fileMap = new Map(files.map(f => [fs.realpathSync(f).toLowerCase(), rel(f)]));
const before = new Map(files.map(file => [file, sha(fs.readFileSync(file))]));
const configFile = path.join(out, 'tsconfig.audit.json');
fs.writeFileSync(configFile, JSON.stringify({ extends: path.join(root, 'tsconfig.json'), compilerOptions: {allowJs:true, checkJs:false, noEmit:true, typeRoots:[path.join(root,'node_modules/@types')]}, files, include:[], exclude:[] }, null, 2)+'\n');

const controlCases = [
 {name:'DAG',vertices:['a','b','c'],edges:[['a','b'],['b','c']],expected:[]},
 {name:'pair-cycle',vertices:['a','b','c'],edges:[['a','b'],['b','a']],expected:[['a','b']]},
 {name:'self-loop',vertices:['a','b'],edges:[['a','a']],expected:[['a']]},
].map(test=>{const result=tarjan(test.vertices,test.edges); assert.deepEqual(result.cyclicScc,test.expected); return {...test,result,passed:true};});
fs.writeFileSync(path.join(out,'tarjan-controls.json'), JSON.stringify(controlCases,null,2)+'\n');

let git={};try {git={head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(),status:execFileSync('git',['status','--porcelain=v1'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()};}catch{}
const edges=[], untraceable=[], syntaxDiagnostics=[], missingAst=[];
const api=new API({cwd:root});
function literal(node) { return node && (ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null; }
try {
 const snapshot=api.updateSnapshot({openProjects:[configFile]});
 const project=snapshot.getProject(configFile);
 if(!project) throw new Error('Compiler API did not open audit config');
 function resolve(specifier, from, literalNode) {
  // Compiler symbol resolution handles TypeScript module substitution and aliases.
  let symbol, declarations=[];
  try {symbol=project.checker.getSymbolAtLocation(literalNode); declarations=symbol?.declarations || [];}catch{}
  const resolvedFiles=[...new Set(declarations.map(d=>d.resolve(project)?.getSourceFile()?.fileName).filter(Boolean))];
  const inside=resolvedFiles.map(f=>fileMap.get(fs.realpathSync(f).toLowerCase())).filter(Boolean);
  if(inside.length===1) return {resolution:'internal',to:inside[0],via:'typescript-checker',resolvedFiles:resolvedFiles.map(rel)};
  if(inside.length>1) return {resolution:'ambiguous',candidates:inside,via:'typescript-checker'};
  if(specifier.startsWith('node:')) return {resolution:'external',externalKind:'node-builtin',to:specifier,resolvedFiles:resolvedFiles.map(rel)};
  if(resolvedFiles.length) {
   const json=resolvedFiles.length===1 && resolvedFiles[0].endsWith('.json') && !rel(resolvedFiles[0]).startsWith('..');
   return {resolution:json?'asset':resolvedFiles.every(f=>rel(f).startsWith('..')||f.includes('/node_modules/'))?'external':'out-of-scope',to:json?rel(resolvedFiles[0]):specifier,via:'typescript-checker',resolvedFiles:resolvedFiles.map(rel)};
  }
  // Exact-file fallback reports its method; it does not guess alias or extension resolution.
  if(specifier.startsWith('.')) {
   const target=path.resolve(path.dirname(from),specifier);
   if(fs.existsSync(target)&&fs.statSync(target).isFile()) {
    const internal=fileMap.get(fs.realpathSync(target).toLowerCase());
    return {resolution:internal?'internal':target.endsWith('.json')?'asset':'out-of-scope',to:internal||rel(target),via:'exact-filesystem'};
   }
   return {resolution:'unresolved',to:specifier};
  }
  return {resolution:'external',externalKind:'unresolved-package-or-url',to:specifier};
 }
 for(const file of files) {
  const sf=project.program.getSourceFile(file);
  if(!sf){missingAst.push(rel(file));continue;}
  for(const d of project.program.getSyntacticDiagnostics(file)) syntaxDiagnostics.push({file:rel(file),code:d.code,start:d.start,length:d.length,message:d.messageText});
  const visited=new Set();
  const location=node=>{const p=sf.getLineAndCharacterOfPosition(node.getStart(sf));return {line:p.line+1,column:p.character+1};};
  function add(node,specNode,kind,typeOnly=false,extra={}) {
   const specifier=literal(specNode);
   const base={from:rel(file),...location(node),kind,typeOnly:typeOnly||sf.isDeclarationFile,runtime:!typeOnly&&!sf.isDeclarationFile,...extra};
   if(specifier===null){untraceable.push({...base,expression:specNode?.getText(sf)??null,reason:'non-literal module specifier; no value-flow execution'});return;}
   edges.push({...base,specifier,...resolve(specifier,file,specNode)});
  }
  function visit(node) {
   const key=`${node.pos}:${node.end}:${node.kind}`;if(visited.has(key))return;visited.add(key);
   if(ts.isImportDeclaration(node)) {
    const clause=node.importClause;
    add(node,node.moduleSpecifier,'import-declaration',!!clause?.isTypeOnly,{bindings:clause?.namedBindings&&ts.isNamedImports(clause.namedBindings)?clause.namedBindings.elements.map(e=>({name:e.name.text,importedName:e.propertyName?.text||e.name.text,localName:e.name.text,typeOnly:!!clause.isTypeOnly||!!e.isTypeOnly})):[]});
   } else if(ts.isExportDeclaration(node)&&node.moduleSpecifier) {
    add(node,node.moduleSpecifier,'re-export',!!node.isTypeOnly,{bindings:node.exportClause&&ts.isNamedExports(node.exportClause)?node.exportClause.elements.map(e=>({name:e.name.text,importedName:e.propertyName?.text||e.name.text,exportedName:e.name.text,typeOnly:!!node.isTypeOnly||!!e.isTypeOnly})):[]});
   } else if(ts.isImportTypeNode(node)) {
    add(node,ts.isLiteralTypeNode(node.argument)?node.argument.literal:node.argument,'import-type-expression',true);
   } else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)) {
    add(node,node.moduleReference.expression,'import-equals',!!node.isTypeOnly);
   } else if(ts.isCallExpression(node)) {
    if(node.expression.kind===ts.SyntaxKind.ImportKeyword) add(node,node.arguments[0],'dynamic-import');
    else if(ts.isIdentifier(node.expression)&&node.expression.text==='require') add(node,node.arguments[0],'require-call',false,{caveat:'syntactic require; shadowing is not resolved'});
   } else if(ts.isJSDocImportTag?.(node)) {
    add(node,node.moduleSpecifier,'jsdoc-import',true);
   }
   node.forEachChild(child=>{visit(child);});
   for(const doc of node.jsDoc||[]) visit(doc);
  }
  visit(sf);
  for(const ref of sf.referencedFiles||[]) {
   const target=path.resolve(path.dirname(file),ref.fileName);
   edges.push({from:rel(file),line:sf.getLineAndCharacterOfPosition(ref.pos).line+1,kind:'reference-path',typeOnly:true,runtime:false,specifier:ref.fileName,resolution:fileMap.has(target.toLowerCase())?'internal':fs.existsSync(target)?'out-of-scope':'unresolved',to:fileMap.get(target.toLowerCase())||rel(target),via:'reference-path'});
  }
  for(const ref of sf.typeReferenceDirectives||[]) edges.push({from:rel(file),line:sf.getLineAndCharacterOfPosition(ref.pos).line+1,kind:'reference-types',typeOnly:true,runtime:false,specifier:ref.fileName,resolution:'external',to:ref.fileName,externalKind:'type-reference'});
 }
 snapshot.dispose();
} finally {api.close();}
const nodes=files.map(file=>({file:rel(file),sha256:before.get(file),bytes:fs.statSync(file).size,declarationOnly:/\.d\.[cm]?ts$/.test(file),developmentOnly:rel(file).startsWith('src/dev/')}));
const changedDuringRead=files.filter(file=>sha(fs.readFileSync(file))!==before.get(file)).map(rel);
function graph(runtime) {
 const rows=edges.filter(e=>e.resolution==='internal'&&(!runtime||e.runtime));
 const pairs=[...new Set(rows.map(e=>JSON.stringify([e.from,e.to])))].map(s=>JSON.parse(s));
 const result=tarjan(nodes.map(n=>n.file),pairs);
 return {vertexCount:nodes.length,uniqueEdgeCount:pairs.length,importOccurrenceCount:rows.length,edges:pairs,sccCount:result.scc.length,scc:result.scc,cyclicScc:result.cyclicScc};
}
const report={schemaVersion:1,createdAt:new Date().toISOString(),root,compiler:{name:compilerPackage.name,version:compilerPackage.version,api:'typescript/unstable/sync + typescript/unstable/ast'},git,scope:{includedRoots,extensions:sourcePattern.source,excludes:[...excludes],developmentEntriesIncluded:true,symlinkPolicy:'skip-and-report',skippedSymlinks},sourceSnapshotHash:sha(nodes.map(n=>`${n.file}\0${n.sha256}`).join('\n')),nodes,imports:edges,graphs:{runtime:graph(true),full:graph(false)},external:edges.filter(e=>e.resolution==='external'),assets:edges.filter(e=>e.resolution==='asset'),unresolved:edges.filter(e=>e.resolution==='unresolved'||e.resolution==='ambiguous'),outOfScope:edges.filter(e=>e.resolution==='out-of-scope'),untraceableDynamicImports:untraceable,syntaxDiagnostics,missingAst,changedDuringRead,tarjanControls:controlCases,limitations:[
 'Static source import graph, not a call/data-flow graph and not proof of behavioral independence.',
 'Runtime means potential runtime loading from source syntax: literal dynamic imports are included regardless of reachability/conditions.',
 'import type/export type/import type expressions are type-only; inline type specifiers in a retained import/export declaration can still load the module for side effects under verbatimModuleSyntax.',
 'Only literal module specifiers resolved. Nonliteral dynamic imports/require are reported, not evaluated. require aliases/custom loaders/eval and generated imports are not followed.',
 'External packages, Node builtins, JSON assets and outside-scope files are leaves and excluded from Tarjan. Dependencies inside packages are not traversed.',
 'Scope includes src/dev design studies; their imports are factual source edges, not evidence of release inclusion.',
 'TS compiler syntax is inspected, not transpiled output/bundler behavior. No product behavior tests, build, deployment, HTTP or Python execution occurred.',
 'Direct process launches are not import edges. Python imports are a separate AST graph.',
 'No normative permission matrix is inferred from current imports. Existing-vs-approved owner rules require an independently declared policy.',
]};
fs.writeFileSync(path.join(out,'typescript-import-graph.json'),JSON.stringify(report,null,2)+'\n');
const summary={files:nodes.length,importOccurrences:edges.length,runtimeEdges:report.graphs.runtime.uniqueEdgeCount,fullEdges:report.graphs.full.uniqueEdgeCount,runtimeCycles:report.graphs.runtime.cyclicScc,fullCycles:report.graphs.full.cyclicScc,externalOccurrences:report.external.length,assets:report.assets.length,unresolved:report.unresolved.length,outOfScope:report.outOfScope.length,untraceable:untraceable.length,syntaxDiagnostics:syntaxDiagnostics.length,missingAst,changedDuringRead,tarjanControls:controlCases.every(c=>c.passed),sourceSnapshotHash:report.sourceSnapshotHash};
fs.writeFileSync(path.join(out,'typescript-summary.json'),JSON.stringify(summary,null,2)+'\n');
return { report, summary };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const { summary } = await collectImports(process.argv[2] || process.cwd(),
  process.argv[3] || path.dirname(fileURLToPath(import.meta.url)));
 console.log(JSON.stringify(summary, null, 2));
 if (summary.missingAst.length || summary.changedDuringRead.length || summary.syntaxDiagnostics) process.exitCode = 2;
}
