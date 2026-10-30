import type {ChartSession} from '../state/chart-session.ts';
import type {ChartExploration} from '../state/chart-exploration.ts';
import type {ReturnsController} from '../state/returns.ts';
import type {MomentTimeline} from '../state/moment-timeline.ts';
import type {NatalDayExplorer} from '../state/natal-day.ts';
import type {LiveTransit} from '../state/live-transit.ts';
import type {WorkspaceState} from '../state/workspace.ts';
import type {ChartHeadingLayout} from '../ui/layout/chart-heading.ts';
import type {LifetimeControls} from './lifetime-controls.ts';
import type {ReturnsPanel} from './returns-panel.ts';
import type {ChartSummaryPanel} from './chart-summary-panel.ts';
import type {attachReturnMarkers} from './returns-markers.ts';
import {chartCaption} from './chart-display.ts';
import {chartPresentation} from '../domain/chart-presentation.ts';
import {studioPresentation,type StudioPresentation} from '../ui/studio-presentation.ts';
import {returnsVisibleWindow} from '../domain/returns-window.ts';
import {cycleTimeZone} from '../domain/cycles.ts';
interface ChartToolsPorts {
 document:Document;signal:AbortSignal;session:ChartSession;workspace:Pick<WorkspaceState,'screen'>;heading:ChartHeadingLayout;
 readonly returns:ReturnsController|null;readonly lifetime:MomentTimeline|null;readonly natalDay:NatalDayExplorer|null;
 readonly exploration:ChartExploration|null;readonly transit:LiveTransit|null;readonly chartSummary:ChartSummaryPanel|null;
 readonly returnsView:ReturnsPanel|null;readonly lifetimeControls:LifetimeControls|null;
 readonly returnMarkers:ReturnType<typeof attachReturnMarkers>|null;
 initialPage:{active:boolean};readonly initialPresentation:StudioPresentation|null;readonly loadFailed:boolean;
 restored():boolean;connection():string;nowUtc():string;
 loadReturnsView():unknown;layout(view:StudioPresentation):boolean|void;updated():void;
}
/** Projects the accepted chart and tool owners; it never starts an application scenario. */
export function createChartToolsView(ports:ChartToolsPorts) {
  const $=<T extends Element=HTMLElement>(id:string)=>ports.document.getElementById(id) as unknown as T;
  let captionPending=false;
  function caption() {
    const {workspace,session,returns,heading}=ports;
    if (workspace.screen !== 'chart') { captionPending = true; return; }
    captionPending = false;
    const chart = session.current;
    // The accepted composition describes the shown moment, even while another
    // source is loading. A pending owner must not change the natal caption.
    const text = chartCaption(chart, session.record,
      { useUtc: session.shownSource === 'lifetime',
        showAge: Boolean(returns?.available),
        ageUtc: ports.nowUtc() });
    heading.updateText(text.title, text.subtitle, text.moments);
  }

  function presentation() {
    const {initialPage,initialPresentation,exploration,lifetime,session,returns,natalDay}=ports;
    if (initialPage.active && !ports.restored() && initialPresentation) return initialPresentation;
    const timeline = exploration!.pendingTimeline || lifetime?.state;
    const source=chartPresentation(session.selectedId,session.record);
    return studioPresentation({ isTransit: source.isTransit,
      personalAvailable: source.personalAvailable && Boolean(returns?.available), dayOpened: Boolean(natalDay?.state.opened),
      lifetime: timeline ? { opened: timeline.opened, mode: timeline.mode } : null, returnsOpened: Boolean(returns?.opened),
      returnsEnabled: exploration!.returnsEnabled, transitEnabled: exploration!.transitEnabled,
      loadFailed: ports.loadFailed });
  }

  function update() {
    if(ports.signal.aborted)return;
    const {returns,lifetime,initialPage,session,exploration,transit,chartSummary,returnsView,lifetimeControls,returnMarkers}=ports;
    if (!returns) return;
    const state = returns!.state, lifetimeState = lifetime?.state, metadata = lifetimeState?.metadata;
    const view = presentation();
    const dayOpen = view.timelinePanel === 'natal-day';
    $('natalDayToggle').setAttribute('aria-expanded', String(dayOpen));
    $('natalDayToggle').setAttribute('aria-pressed', String(dayOpen));
    // The final startup projection must also replace the shell's visibility.
    if (initialPage.active) {
      for (const [kind, id] of [['transit', 'transitControls'], ['natal-day', 'natalDayControls'], ['lifetime', 'lifetimeControls']] as const)
        $(id).hidden = kind !== view.timelinePanel;
    }
    const heading = $('lifetimeControls').querySelector<HTMLElement>('.lifetime-heading')!;
    heading.hidden = !view.lifetimeHeadingVisible; heading.inert = !view.lifetimeHeadingVisible;
    $('lifetimeControls').dataset.personalLife = String(state.available);
    $('summaryReturns').hidden = !state.available;
    $<HTMLButtonElement>('summaryReturns').disabled = !state.opened && !state.canOpen;
    // Source labels describe the same resolved chart as the scene.
    const chart = session.current;
    const viewState = { ...state, visible: view.returnsVisible,
      birthSelected: !exploration!.live && chart.primary === session.baseChart && !chart.secondary, live: exploration!.live,
      nowAvailable: ports.connection() !== 'offline' || transit?.state.referenceIndex != null };
    chartSummary!.setReturnsVisible(view.returnsVisible);
    if (returnsView) returnsView!.update(viewState);
    else if (view.returnsVisible) void ports.loadReturnsView();
    const lifetimeToggle = $('lifetimeToggle');
    lifetimeToggle.hidden = !view.lifetimeAvailable;
    (lifetimeToggle as HTMLButtonElement).disabled = !view.toggleEnabled && (ports.connection() === 'offline'
      && !lifetimeState?.metadata && (session.selectedId !== 'current-transit' || !transit?.state.current));
    lifetimeToggle.title = view.toggleLabel;
    lifetimeToggle.setAttribute('aria-label', view.toggleLabel);
    lifetimeToggle.setAttribute('aria-controls', 'lifetimeControls');
    lifetimeToggle.setAttribute('aria-expanded', String(view.toggleEnabled));
    lifetimeToggle.setAttribute('aria-pressed', String(view.toggleEnabled));
    const valid = view.personalTimelineVisible && metadata;
    const window = valid ? returnsVisibleWindow(state.natal, state.year, lifetimeState) : null;
    lifetimeControls?.setVisibleWindow(window && { ...window, calendar: Number.isInteger(state.year),
      timeZone: cycleTimeZone(state.natal?.timezone) });
    returnMarkers?.update({ events: state.events, natal: state.natal, displayedUtc: chart?.utc,
      readyEvents: state.offline ? state.readyEvents : undefined,
      fromUtc: window?.minUtc ?? NaN,
      toUtc: window?.maxUtc ?? NaN,
      visible: Boolean(valid) });
    const changed = ports.layout(view);
    ports.updated();
    return changed;
  }

  return {caption,presentation,update,get captionPending(){return captionPending;}};
}
