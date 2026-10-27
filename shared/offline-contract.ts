/** Only generated, public application files belong to the offline bundle. */
export interface OfflineFile { url: string; sha256: string; bytes: number }
export interface OfflineManifest { version: string; files: OfflineFile[] }
export const OFFLINE_VERSION = /^[a-f0-9]{64}$/;
export const OFFLINE_ASSET = /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf)$/;
export type OfflineCommand =
 | { type: 'forma-offline'; action: 'status' }
 | { type: 'forma-offline'; action: 'activate-approved-version'; version: string }
 | { type: 'forma-offline'; action: 'retire-approved-version'; version: string; previousVersion: string };
export interface OfflineStatus { version: string; ready: boolean; previousVersions?: string[] }
export type OfflineReply = {type:'forma-offline';action:OfflineCommand['action'];accepted:boolean} & Partial<OfflineStatus>;
/** One transient check of the current tab owners; never a stored tab identity. */
export interface OfflineTabRequest {
 type:'forma-offline-tab';action:'prepare-tab'|'verify-restored-tab'|'cancel-tab-update';
 version:string;requestId:string;
}
export interface OfflineTabReply {
 type:'forma-offline-tab';version:string;requestId:string;ready:boolean;loadedVersion?:string;
}

export function validateOfflineManifest(value: OfflineManifest): OfflineManifest {
 if (!value || !OFFLINE_VERSION.test(value.version) || !Array.isArray(value.files)) throw new TypeError('Invalid offline manifest');
 const urls=new Set<string>();
 const files=value.files.map(file=>{
  if (!file || !['/index.html','/love.html'].includes(file.url) && !OFFLINE_ASSET.test(file.url)
   || urls.has(file.url) || !OFFLINE_VERSION.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes<0) throw new TypeError('Invalid offline file');
  urls.add(file.url);return {url:file.url,sha256:file.sha256,bytes:file.bytes};
 });
 if (!urls.has('/index.html')) throw new TypeError('Offline shell is missing');
 return {version:value.version,files};
}
