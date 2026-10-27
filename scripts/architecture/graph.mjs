export function tarjan(vertices, edges) {
 const adjacent=new Map(vertices.map(v=>[v,new Set()]));
 for(const [a,b] of edges)if(adjacent.has(a)&&adjacent.has(b))adjacent.get(a).add(b);
 let next=0;const indices=new Map(),low=new Map(),stack=[],onStack=new Set(),components=[];
 function visit(v){indices.set(v,next);low.set(v,next++);stack.push(v);onStack.add(v);
  for(const w of adjacent.get(v))if(!indices.has(w)){visit(w);low.set(v,Math.min(low.get(v),low.get(w)));}else if(onStack.has(w))low.set(v,Math.min(low.get(v),indices.get(w)));
  if(low.get(v)===indices.get(v)){let w;const c=[];do{w=stack.pop();onStack.delete(w);c.push(w);}while(w!==v);components.push(c.sort());}}
 for(const v of vertices)if(!indices.has(v))visit(v);
 components.sort((a,b)=>a[0].localeCompare(b[0]));
 return {scc:components,cyclicScc:components.filter(c=>c.length>1||adjacent.get(c[0]).has(c[0]))};
}
