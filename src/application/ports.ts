import type {SavedChart} from '../../shared/chart-types.ts';
import type {PublicAccountChart} from '../../shared/chart-record-contract.ts';
import type {AccountLibrary} from '../state/account-library.ts';
import type {SavedBirthForm} from '../domain/birth-form-draft.ts';
import type { AppRoute } from '../../shared/app-routes.ts';
import type { UpdatePort } from './update.ts';
import type { StartupPorts, StartupEvent } from './startup.ts';
import type { PublicRefreshPorts, PublicRefreshEvent } from './public-refresh.ts';
import type { WriteContinuationPorts, WriteEvent } from './write-continuation.ts';
import type {BackgroundWorkPorts,BackgroundWorkEvent} from './background-work.ts';
import type {LibraryFillPorts,LibraryFillEvent} from './library-fill.ts';
import type {LibraryAuditPorts,LibraryAuditEvent} from './library-local-audit.ts';

export interface AccountAccess { readonly accountId: string; readonly sessionId: string; readonly diagnosticProof?: string }
export interface AccountBoundaryRequest {
  readonly runtimeId: string;
  readonly generation: number;
  readonly access: AccountAccess | null;
  readonly previous: AccountAccess | null;
  readonly logoutIds: readonly string[] | null;
}
export interface AccountBoundaryWork {
  readonly ready: Promise<void>;
  retry(): Promise<void>;
  readonly reset:boolean;
}
export type AccountCleanupResult={status:'cleared'|'pending'|'unavailable'};
export interface AccountBoundaryOperations {
  library:Pick<AccountLibrary,'accountId'|'connect'|'clear'|'retryClear'|'restore'|'storageAvailable'>;
  calculations?:{resetPersonal():Promise<AccountCleanupResult>;retryPersonalCleanup():Promise<AccountCleanupResult|null>};
  writes:{readonly pending:readonly {expectedAccountId:string}[];clear():void};
  binding:{readonly accountId:string|null;clear():void};
  form:{readonly pending:SavedBirthForm|null|undefined;readonly snapshot:SavedBirthForm|null|undefined;readonly opened:boolean;
    clearPending():void;discardInput():void;close():void};
  editing:{reset():void};
  checkpoint:{clearPersonal():boolean;flush():boolean};
  closeDelete():void;
}
export interface AccountJournal {
  setAccount(accountId:string|null,sessionId?:string|null,proof?:string):unknown;
  leave(ids?:readonly string[]):unknown;
}
export type AccountBoundaryResult={status:'ready'|'failed'|'stopped'|'superseded'};
export interface AccountPort extends AccountBoundaryOperations {
  readonly ready:Promise<unknown>;
  getSession():AccountAccess|null;
  subscribeSession(listener: (access: AccountAccess | null) => void): () => void;
  subscribeLogout(listener: (ids: readonly string[]) => void): () => void;
  journal?:AccountJournal;
  changed():void;
  storageUnavailable():void;
}
export type AccountEvent =
  | {type: 'SessionChanged'; access: AccountAccess | null}
  | {type: 'LogoutObserved'; ids: readonly string[]}
  | {type: 'RetryAccountBoundary'}
  | {type:'JournalAttached';journal:AccountJournal};

export interface NavigationSnapshot { readonly route: AppRoute | null; readonly revision: number }
export type NavigationOrigin = 'external' | 'publication';
export interface NavigationPort {
  readonly snapshot: NavigationSnapshot;
  isCurrent(snapshot: NavigationSnapshot): boolean;
  navigate(route: AppRoute, options?: {replace?: boolean; origin?: NavigationOrigin}): boolean;
  subscribe(listener: (snapshot: NavigationSnapshot, origin: NavigationOrigin) => void): () => void;
}
export interface RouteRequest {
  readonly snapshot: NavigationSnapshot;
  readonly selection?:{id:string;edit?:boolean;keepMenuOpen?:boolean};
  readonly initial: boolean;
  readonly runtimeId: string;
  readonly processId: number;
}
export interface RoutePort {
  library:Pick<AccountLibrary,'get'|'has'|'open'>;
  sources:{readonly charts:readonly SavedChart[];readonly publicChart:PublicAccountChart|null;readonly temporaryChart:SavedChart|null;
    get(id:string):SavedChart|null|undefined;acceptPublic(chart:PublicAccountChart):unknown;clearPublic(id:string):unknown};
  session:{readonly selectedId:string};
  online():boolean;now():number;
  readPublic(id:string,signal?:AbortSignal):Promise<PublicAccountChart>;
  observe(stage:'request'|'storage_read'):{failed(error:unknown):void;finish():void}|null;
  view:{
    workspace(screen:'chart'|'account'|'charts'|'knowledge',keepMenuOpen?:boolean):void;
    select(id:string):void;resetCamera():void;edit(id:string):void;
    interrupt():void;settled():void;checkpoint():void;report(error:unknown):void;
    firstTransit():Promise<boolean|void>;transitReady(ready:boolean):void;
    markOpened(id:string):void;publicRead(checkedAt:number,receivedAt:number):void;
  };
}
export interface ApplicationPorts { runtimeId: string; navigation?: NavigationPort; route?:RoutePort; account?: AccountPort; write?:WriteContinuationPorts; publicRefresh?:PublicRefreshPorts; startup?:StartupPorts; update?:UpdatePort;background?:BackgroundWorkPorts;libraryFill?:LibraryFillPorts;libraryAudit?:LibraryAuditPorts }
export type ApplicationEvent =
  | {type: 'RouteRequested'; snapshot: NavigationSnapshot; initial?: boolean}
  | {type: 'RoutePublished'; route: AppRoute; replace?: boolean}
  | {type:'OpenChartRequested';id:string;edit?:boolean;keepMenuOpen?:boolean}
  | {type:'ChartSelected';id:string;keepMenuOpen?:boolean;fromRoute?:boolean;replace?:boolean}
  | {type:'WorkspaceRequested';screen:'chart'|'account'|'charts'|'knowledge';keepMenuOpen?:boolean;fromRoute?:boolean}
  | {type: 'RetryRoute'}
  | AccountEvent | Exclude<StartupEvent,{type:'Stop'}> | PublicRefreshEvent | BackgroundWorkEvent | LibraryFillEvent | LibraryAuditEvent | Exclude<WriteEvent,{type:'Stop'|'SourcesReconciled'}>;
export interface ApplicationView {
  lifecycle: 'created' | 'running' | 'stopping' | 'stopped';
  destination: 'idle' | 'preparing' | 'ready' | 'failed';
  request: RouteRequest | null;
}
