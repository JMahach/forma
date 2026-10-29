import type { AppRoute } from '../../shared/app-routes.ts';

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
export interface ApplicationPorts { navigation: NavigationPort; route(request: RouteRequest): RoutePort }
export type ApplicationEvent =
  | {type: 'RouteRequested'; snapshot: NavigationSnapshot; initial?: boolean}
  | {type: 'RoutePublished'; route: AppRoute; replace?: boolean}
  | {type: 'RetryRoute'};
export interface ApplicationView {
  lifecycle: 'created' | 'running' | 'stopping' | 'stopped';
  destination: 'idle' | 'preparing' | 'ready' | 'failed';
  request: RouteRequest | null;
}
