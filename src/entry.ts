// Keep this boundary free of static imports: a missing startup dependency
// must still leave the server preview and a working recovery action.
try {
  // Stand scripts are stripped from release HTML. Wait for the existing
  // module URL to install its request gate before startup reads data.
  const stand = document.querySelector<HTMLScriptElement>('script[data-development][src="/src/dev/control-colors.ts"]');
  if (stand) await import(stand.src);
  await import('./startup.ts');
} catch {
  const shell = document.querySelector<HTMLElement>('.app-shell')!;
  const art = document.getElementById('chartLoadingArt');
  shell.hidden = !art;
  shell.inert = !art;
  delete shell.dataset.shellReady;
  shell.dataset.pageState = 'error';
  shell.setAttribute('aria-busy', 'false');
  const message = document.getElementById('chartLoadingMessage')!;
  if (art) {
    art.hidden = false;
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
