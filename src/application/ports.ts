import type { AppRoute } from '../../shared/app-routes.ts';
import type { StartupPorts, StartupEvent } from './startup.ts';
import type { PublicRefreshPorts, PublicRefreshEvent } from './public-refresh.ts';
import type { WriteContinuationPorts, WriteEvent } from './write-continuation.ts';

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
  settled(): void;
}
export interface AccountPort {
  subscribeSession(listener: (access: AccountAccess | null) => void): () => void;
  subscribeLogout(listener: (ids: readonly string[]) => void): () => void;
  begin(request: AccountBoundaryRequest): AccountBoundaryWork;
  stop(): void;
}
export type AccountEvent =
  | {type: 'SessionChanged'; access: AccountAccess | null}
  | {type: 'LogoutObserved'; ids: readonly string[]}
  | {type: 'RetryAccountBoundary'};

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
  readonly initial: boolean;
  readonly runtimeId: string;
  readonly processId: number;
}
export interface RoutePort {
  enter(): void;
  prepare(signal: AbortSignal, current: () => boolean): Promise<void>;
  apply(): void;
  failed(error: unknown): Promise<void>;
  settled(): void;
  dispose(): void;
}
export interface ApplicationPorts { runtimeId: string; navigation?: NavigationPort; route(request: RouteRequest): RoutePort; account?: AccountPort; write?:WriteContinuationPorts; publicRefresh?:PublicRefreshPorts; startup?:StartupPorts }
export type ApplicationEvent =
  | {type: 'RouteRequested'; snapshot: NavigationSnapshot; initial?: boolean}
  | {type: 'RoutePublished'; route: AppRoute; replace?: boolean}
  | {type: 'RetryRoute'}
  | AccountEvent | Exclude<StartupEvent,{type:'Stop'}> | PublicRefreshEvent | Exclude<WriteEvent,{type:'Stop'|'SourcesReconciled'}>;
export interface ApplicationView {
  lifecycle: 'created' | 'running' | 'stopping' | 'stopped';
  destination: 'idle' | 'preparing' | 'ready' | 'failed';
  request: RouteRequest | null;
}
