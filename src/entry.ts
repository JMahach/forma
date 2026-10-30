import type { createJournal } from './journal.ts';
// Keep this boundary free of static imports: a missing startup dependency
// must still leave a plain background and a working recovery action.
declare const __FORMA_RELEASE__: boolean;

// The HTTP owner supplies one name for both the tab and the visible shell.
// Apply it before any optional import, including the real loading preview.
const appName=document.body.dataset.appName;
if(appName) {
  document.title=appName;
  const label=document.querySelector<HTMLElement>('.site-brand span');
  if(label)label.textContent=appName;
  document.querySelector('.site-brand')?.setAttribute('aria-label',appName);
}

type Journal=ReturnType<typeof createJournal>;
let journalReady:Promise<Journal|undefined>|undefined;
function prepareJournal():Promise<Journal|undefined> {
  if(journalReady)return journalReady;
  const metadata=document.body.dataset;
  if(!metadata?.appVersion || !['stand','production'].includes(metadata.appEnvironment??''))return Promise.resolve(undefined);
  // Optional diagnostics load beside the application, never ahead of its recovery UI.
  journalReady=import('./journal.ts').then(({createJournal})=>{
    const journal=createJournal({appVersion:metadata.appVersion!,
      environment:metadata.appEnvironment as 'stand'|'production'});
    journal.attachBrowser(window,navigator);return journal;
  }).catch(()=>undefined);
  return journalReady;
}
try {
  // One palette owner restores the chosen drawing style before the real startup.
  if (document.getElementById('toggleLoadingPreview')) await import('./preview/control-colors.ts');
  void prepareJournal();
  const startup=await import('./startup.ts');
  // Only a built, complete public bundle is eligible for offline installation.
  // Installation stays optional/background; updates wait for restoration approval.
  if(typeof __FORMA_RELEASE__!=='undefined' && __FORMA_RELEASE__) {
    try { void (async()=>{
      if(!navigator.serviceWorker)return;
      const loadedVersion=document.body.dataset.offlineVersion;
      if(!loadedVersion)return;
      const {attachOfflinePage,holdOfflineInput}=await import('./offline/page-coordinator.ts');
      let stopped=false,registration:ServiceWorkerRegistration|undefined,page:ReturnType<typeof attachOfflinePage>|undefined;
      const observe=async()=>{
        const current=registration??await navigator.serviceWorker.getRegistration('/');
        if(stopped || !current)return;
        registration=current;
        page??=attachOfflinePage({registration,serviceWorker:navigator.serviceWorker,loadedVersion,
          owner:{prepare:startup.prepareOfflineUpdate,restored:startup.offlineRestored,subscribe:startup.subscribeOfflineReady},
          hold:()=>holdOfflineInput(window),reload:()=>location.reload()});
        void page.check();
      };
      await observe();
      const install=async(signal:AbortSignal)=>{
        if(stopped || signal.aborted)return;
        registration??=await navigator.serviceWorker.getRegistration('/');
        if(stopped || signal.aborted)return;
        registration??=await navigator.serviceWorker.register('/service-worker.js',{scope:'/',updateViaCache:'none'});
        if(!signal.aborted)await observe();
      };
      startup.connectReleaseCheck({install,async check(signal){
        if(stopped || signal.aborted)return;
        registration??=await navigator.serviceWorker.getRegistration('/');
        if(stopped || signal.aborted)return;
        if(registration){await observe();if(!stopped && !signal.aborted)await page?.refresh(signal);}
        else await install(signal);
      },observe(){void observe().catch(()=>{});},stop(){stopped=true;page?.dispose();}});
      void startup.offlineReady().then(observe).catch(()=>{});
    })().catch(()=>{}); }
    catch { /* Browser storage/security restrictions must not hide the working app. */ }
  }
  void prepareJournal().then(journal=>{if(journal)startup.connectJournal(journal);}).catch(()=>{});
} catch {
  void prepareJournal().then(journal=>journal?.begin({action:'startup',component:'entry'})
    .reportFailure({stage:'render',reason:'unclassified_error'})).catch(()=>{});
  const shell = document.querySelector<HTMLElement>('.app-shell')!;
  const art = document.getElementById('chartLoadingArt');
  shell.hidden = !art;
  shell.inert = !art;
  delete shell.dataset.shellReady;
  shell.dataset.pageState = 'error';
  shell.setAttribute('aria-busy', 'false');
  const message = document.getElementById('chartLoadingMessage')!;
  if (art) {
    art.setAttribute('hidden', '');
    const canvas = document.getElementById('canvasWrap');
    if (canvas) canvas.dataset.chartState = 'error';
    const studio = document.querySelector<HTMLElement>('.studio');
    if (studio) studio.dataset.workspaceScreen = 'chart';
  } else document.body.append(message);
  message.hidden = false;
  document.getElementById('chartLoadingStatus')!.textContent = 'Не удалось загрузить приложение';
  const retry = document.getElementById('chartLoadingRetry')!;
  retry.hidden = false;
  retry.addEventListener('click', () => location.reload());
}
