import { UI_MESSAGES } from '../ui/messages.ts';
interface ChartLoadingOptions { canvas: HTMLElement; drawing: SVGSVGElement & { inert?: boolean }; art: Element; message: HTMLElement; status: HTMLElement; retry: HTMLButtonElement; heading: HTMLElement; onRetry: () => void }
export interface ChartLoadingState { hasChart: boolean; failed?: boolean; loading?: boolean; holdLoading?: boolean; preserveHeading?: boolean }
export type ChartLoading = ReturnType<typeof attachChartLoading>;

// Presentation only: the session owns whether a chart exists; its active
// moment source owns loading/errors. A ready chart must never wait for the rest of the day packet.
export function attachChartLoading({ canvas, drawing, art, message, status, retry, heading, onRetry }: ChartLoadingOptions) {
  let previous: 'ready' | 'error' | 'loading' | null = null;
  let previousHeading = false;
  retry.addEventListener('click', onRetry);
  return {
    update({ hasChart, failed = false, loading = false, holdLoading = false, preserveHeading = false }: ChartLoadingState) {
      const state = hasChart && !holdLoading ? 'ready' : failed && !loading ? 'error' : 'loading';
      if (state === previous && preserveHeading === previousHeading) return;
      previous = state;
      previousHeading = preserveHeading;
      const ready = state === 'ready';
      canvas.dataset.chartState = state;
      canvas.setAttribute('aria-busy', String(state === 'loading'));
      canvas.inert = false;
      canvas.setAttribute('tabindex', ready ? '-1' : '0');
      drawing.inert = !ready;
      drawing.setAttribute('tabindex', ready ? '0' : '-1');
      drawing.setAttribute('aria-hidden', String(!ready));
      art.toggleAttribute('hidden', ready);
      message.hidden = ready;
      heading.style.visibility = ready || preserveHeading ? '' : 'hidden';
      status.textContent = ready ? '' : state === 'error' ? UI_MESSAGES.chartUnavailable : UI_MESSAGES.chartLoading;
      retry.hidden = state !== 'error';
    },
  };
}


// Keep panel buttons usable while their contents and chart tools are still
// loading. The caller releases only restrictions introduced by this hold;
// panel shells and the drawing retain their own accessibility owners.
export function holdLoadingContent(document: Document) {
  const contents = [
    ...['mainNavigation', 'savedChartsSection', 'summaryScreen', 'returnsPanel', 'accountPage', 'knowledgeDialog', 'allChartsDialog',
      'transitControls', 'natalDayControls', 'lifetimeControls', 'togglePerformance', 'toggleControlColors', 'controlColorPreviews', 'randomChartButton'].map(id => document.getElementById(id)),
  ].filter((element): element is HTMLElement => !!element && !element.inert);
  for (const element of contents) element.inert = true;
  return () => { for (const element of contents.splice(0)) element.inert = false; };
}


// Commit each moving surface while initial transitions are disabled. Reading
// only the outer studio leaves its independent right-side chrome unmeasured.
// The first HTML frame has no saved geometry; reveal the whole shell only now.
export function commitLoadingLayout(document: Document) {
  const shell = document.querySelector<HTMLElement>('.app-shell');
  if (shell?.dataset.booting !== 'true') return;
  for (const element of document.querySelectorAll('.library, .chart-summary, .chart-view-tools, .canvas-wrap'))
    element.getBoundingClientRect();
  delete shell.dataset.booting;
  shell.dataset.shellReady = 'true';
}
