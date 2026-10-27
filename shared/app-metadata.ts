/** Runtime facts attached to the public shell, shared by HTTP and offline integrity. */
export interface AppMetadata {
 environment?: 'stand' | 'production';
 appVersion?: string | null;
 calculationVersion?: string | null;
 cyclesVersion?: string | null;
}
const validators: Record<string, RegExp> = {
 'data-app-environment': /^(stand|production)$/,
 'data-app-version': /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/,
 'data-calculation-version': /^[a-f0-9]{64}$/,
 'data-cycles-version': /^[a-f0-9]{64}$/,
};
function attribute(name: string, value: string) {
 if (!validators[name].test(value)) throw new TypeError('Invalid application metadata: '+name);
 return ' '+name+'="'+value+'"';
}
export function appMetadataAttributes({environment='stand', appVersion=null, calculationVersion=null, cyclesVersion=null}: AppMetadata = {}): string {
 attribute('data-app-environment',environment);
 return (cyclesVersion===null?'':attribute('data-cycles-version',cyclesVersion))
  +(calculationVersion===null?'':attribute('data-calculation-version',calculationVersion))
  +(appVersion===null?'':attribute('data-app-environment',environment)+attribute('data-app-version',appVersion));
}
/** Remove only the exact validated attributes added by the HTTP owner.
 * Unknown attributes and all other bytes remain part of the integrity check. */
export function normalizeAppMetadata(html: string): string {
 return html.replace(/<body\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/, body => {
  const seen=new Set<string>(),attributes=body.slice(5,-1);
  let remaining=attributes,kept='';
  while(remaining){
   if(/^\s+$/.test(remaining)){kept+=remaining;break;}
   // Consume a whole top-level attribute, including quoted contents, before
   // considering its name. Metadata-looking text inside a value stays intact.
   const token=/^(\s+)([^\s=/'">]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?/.exec(remaining);
   if(!token)return body;
   const [whole,space,name]=token;
   if(Object.hasOwn(validators,name)){
    const value=/^="([^"]*)"$/.exec(whole.slice(space.length+name.length));
    if(space!==' '||!value||seen.has(name))throw new TypeError('Duplicate or malformed application metadata');
    attribute(name,value[1]);seen.add(name);
   }else kept+=whole;
   remaining=remaining.slice(whole.length);
  }
  return '<body'+kept+'>';
 });
}
