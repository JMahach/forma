// Keep this boundary free of static imports: a missing startup dependency
// must still leave a working recovery action outside the unprepared shell.
try {
  await import('./startup.ts');
} catch {
  const shell = document.querySelector<HTMLElement>('.app-shell')!;
  shell.hidden = true;
  shell.inert = true;
  shell.setAttribute('aria-busy', 'false');
  const message = document.getElementById('chartLoadingMessage')!;
  document.body.append(message);
  message.hidden = false;
  document.getElementById('chartLoadingStatus')!.textContent = 'Не удалось загрузить приложение';
  const retry = document.getElementById('chartLoadingRetry')!;
  retry.hidden = false;
  retry.addEventListener('click', () => location.reload());
}
