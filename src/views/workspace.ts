import type {SavedLifetimeDraft,TextSelection} from '../domain/input-draft.ts';
import type {WorkspaceState} from '../state/workspace.ts';
import type {MomentTimeline} from '../state/moment-timeline.ts';
import type {NatalDayExplorer} from '../state/natal-day.ts';
import type {LiveTransit} from '../state/live-transit.ts';
import type {ReturnsController} from '../state/returns.ts';
import type {ChartSession} from '../state/chart-session.ts';
import type {LifetimeControls} from './lifetime-controls.ts';
import type {attachAllCharts} from './all-charts.ts';
import type {attachKnowledgeEntry} from './knowledge-entry.ts';
import type {attachChartLibrary,ChartLibraryView} from './library.ts';
import type {ChartSummaryPanel} from './chart-summary-panel.ts';
import type {createChartToolsView} from './chart-tools-view.ts';
import {holdLoadingContent,commitLoadingLayout} from './chart-loading.ts';
interface WorkspacePorts {
 document:Document;signal:AbortSignal;workspace:WorkspaceState;studio:HTMLElement;shell:HTMLElement;saved:{lifetimeDraft?:SavedLifetimeDraft|null;account?:{focus?:TextSelection|null}|null;charts?:{focus?:TextSelection|null};knowledge?:{focus?:TextSelection|null}}|null;
 releaseContent?:(()=>void)|null;libraryView:ChartLibraryView;
 account:{ready:Promise<unknown>;setVisible(visible:boolean):unknown;restoreInputFocus(focus:TextSelection):unknown};
 readonly allCharts:ReturnType<typeof attachAllCharts>;readonly knowledge:ReturnType<typeof attachKnowledgeEntry>;
 readonly chartSummary:ChartSummaryPanel|null;readonly chartLibrary:ReturnType<typeof attachChartLibrary>|null;
 readonly activationPopover:{close():void};readonly hoverPreview:{clear():void}|null;
 readonly transit:Pick<LiveTransit,'visibilityChanged'>|null;readonly viewSession:{readonly interrupted:boolean;schedule():void}|null;
 readonly chartTools:ReturnType<typeof createChartToolsView>;readonly session:Pick<ChartSession,'hasCurrent'>;
 readonly lifetimeControls:LifetimeControls|null;readonly lifetime:MomentTimeline|null;
 readonly natalDay:NatalDayExplorer|null;readonly returns:ReturnsController|null;
 readonly lifetimeFailed:boolean;readonly lifetimeLoading:boolean;readonly returnsLoading:boolean;
 drawing:{readonly pending:boolean;render():void};layout:{beginChange():void;refresh():unknown};
 restored():boolean;failed():boolean;loadingChanged():void;
}
/** Browser screen, first reveal and focus. Application restoration stays in the core. */
export function createWorkspaceView(ports:WorkspacePorts) {
  const {document,workspace,studio,shell,saved:savedView}=ports;
  const $=<T extends Element=HTMLElement>(id:string)=>document.getElementById(id) as unknown as T;
  let pendingLifetimeDraft=savedView?.lifetimeDraft??null,pendingInputRestore=true;
  function cancelInputRestore(){pendingInputRestore=false;}
  function discardPendingInput(){cancelInputRestore();pendingLifetimeDraft=null;}
  for(const event of ['pointerdown','keydown','input'])document.addEventListener(event,cancelInputRestore,{capture:true,signal:ports.signal});
  const initialPage={active:true,attached:false,changingTimeline:false,contentFailed:false,screenPending:false,screenFailed:false,screenRevision:0};
  const releaseInitialContent=ports.releaseContent||holdLoadingContent(document);
  ports.signal.addEventListener('abort',releaseInitialContent,{once:true});
  shell.dataset.booting='true';shell.dataset.pageState='loading';shell.inert=false;shell.setAttribute('aria-busy','true');
  let fontsSettled=false;
  const fontsReady=Promise.resolve(document.fonts?.ready).catch(()=>{});
  void fontsReady.then(()=>{fontsSettled=true;updateInitialPage();});
  function updateWorkspaceNavigation() {
    ports.libraryView.setScreen(workspace.screen);
  }
  async function waitForInitialCharts(revision: number) {
    await fontsReady;
    while (!ports.signal.aborted && initialPage.active && revision === initialPage.screenRevision && workspace.screen === 'charts') {
      const ready = await ports.allCharts.whenReady();
      if (ready !== null) return ready;
      // Resize or a changed visible set invalidates only that measurement.
      // The same screen still needs its currently visible pixels.
    }
    return false;
  }
  function applyWorkspace() {
    const {allCharts,knowledge,account,chartSummary,chartLibrary,activationPopover,hoverPreview,transit,viewSession,chartTools}=ports;
    const screen = workspace.screen, revision = ++initialPage.screenRevision;
    const switching = studio.dataset.workspaceScreen !== screen;
    if (switching && studio.dataset.workspaceScreen) discardPendingInput();
    let knowledgeReady: ReturnType<typeof knowledge.show> | null = null;
    // A section return restores the existing panel state, not a drawer command.
    // Commit both the panel and the chart's final width before motion resumes.
    if (switching) studio.dataset.workspaceSwitching = 'true';
    try {
      studio.dataset.workspaceScreen = screen;
      allCharts.setVisible(screen === 'charts');
      knowledgeReady = screen === 'knowledge' ? knowledge.show() : (knowledge.hide(), null);
      $('accountPage').hidden = screen !== 'account';
      account.setVisible(screen === 'account');
      chartSummary!.layout(); chartLibrary!.render(); updateWorkspaceNavigation();
      activationPopover.close(); hoverPreview?.clear();
      ports.layout.beginChange();
      ports.layout.refresh();
    } finally {
      if (switching) {
        studio.getBoundingClientRect();
        delete studio.dataset.workspaceSwitching;
      }
    }
    if (switching) {
      transit?.visibilityChanged();
      if (screen === 'chart') {
        if (chartTools.captionPending) chartTools.caption();
        if (ports.drawing.pending) ports.drawing.render();
      }
    }
    viewSession?.schedule();
    if (initialPage.active) {
      initialPage.screenFailed = false;
      initialPage.screenPending = screen === 'knowledge' || screen === 'charts' || screen === 'account';
      const ready = screen === 'knowledge' ? knowledgeReady : screen === 'charts'
        ? waitForInitialCharts(revision) : screen === 'account' ? account.ready : null;
      if (ready) void Promise.resolve(ready).then(value => {
        if (ports.signal.aborted || revision !== initialPage.screenRevision) return;
        initialPage.screenPending = false; initialPage.screenFailed = value === false; updateInitialPage();
      }, () => {
        if (ports.signal.aborted || revision !== initialPage.screenRevision) return;
        initialPage.screenPending = false; initialPage.screenFailed = true; updateInitialPage();
      });
      updateInitialPage();
    }
  }
  function inputSnapshot<T extends {focus?: unknown} | null | undefined>(current: T, previous: T, screen: 'account' | 'charts' | 'knowledge'): T {
    return pendingInputRestore && workspace.screen === screen && current && previous?.focus
      ? {...current, focus:previous.focus} : current;
  }
  function restoreInitialInput() {
    const {viewSession,lifetimeControls,account,allCharts,knowledge}=ports;
    if ((!pendingInputRestore && !pendingLifetimeDraft) || initialPage.active || !ports.restored()) return;
    if (viewSession?.interrupted) {discardPendingInput();return;}
    if (workspace.screen === 'chart' && pendingLifetimeDraft) {
      if (!lifetimeControls?.restoreDraft(pendingLifetimeDraft,{restoreFocus:pendingInputRestore})) return;
    } else if (pendingInputRestore && workspace.screen === 'account' && savedView?.account?.focus) account.restoreInputFocus(savedView.account.focus);
    else if (pendingInputRestore && workspace.screen === 'charts' && savedView?.charts?.focus) allCharts.restoreInputFocus();
    else if (pendingInputRestore && workspace.screen === 'knowledge' && savedView?.knowledge?.focus) knowledge.restoreInputFocus();
    pendingInputRestore = false; pendingLifetimeDraft = null;
    viewSession?.schedule();
  }
  function updateInitialPage() {
    if(ports.signal.aborted)return;
    if (!initialPage.active || !initialPage.attached || !fontsSettled || initialPage.screenPending || initialPage.changingTimeline) return;
    let failed = initialPage.screenFailed;
    if (workspace.screen === 'chart') {
      if (!ports.restored()) return;
      const view = ports.chartTools.presentation(), cycles = ports.returns!.state, day = ports.natalDay!.state, life = ports.lifetime?.state;
      const cyclesVisible = view.returnsVisible || view.personalTimelineVisible;
      failed ||= ports.failed() || ports.lifetimeFailed || day.opened && day.status === 'error'
        || life?.opened && life.status === 'error' || cyclesVisible && (cycles.errors.length > 0 || Boolean(cycles.chartError));
      if (ports.lifetimeLoading || view.returnsVisible && ports.returnsLoading) return;
      if (!failed && (!ports.session.hasCurrent || day.opened && day.status === 'loading'
        || life?.opened && life.status === 'loading' || cyclesVisible && (cycles.pendingBodies.length > 0 || cycles.loadingChart))) return;
    }
    initialPage.active = false;
    ports.layout.refresh();
    shell.dataset.pageState = failed ? 'error' : 'ready'; shell.inert = false; shell.setAttribute('aria-busy', 'false');
    releaseInitialContent();
    ports.loadingChanged();
    studio.dataset.panelsReady = 'true';
    // Commit final visibility and selected colours with transitions suppressed.
    commitLoadingLayout(document);
    restoreInitialInput();
  }


  return {attach(){initialPage.attached=true;updateInitialPage();commitLoadingLayout(document);},initial:initialPage,update:updateInitialPage,restoreInput:restoreInitialInput,inputSnapshot,discardInput:discardPendingInput,
    get pendingLifetimeDraft(){return pendingLifetimeDraft;},
    start(){const unsubscribe=workspace.subscribe(applyWorkspace);applyWorkspace();return unsubscribe;}};
}
