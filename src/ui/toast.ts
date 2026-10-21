export type Toast = ReturnType<typeof createToast>;
export function createToast(element: HTMLElement) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (message: string) => {
    element.textContent = message;
    element.classList.add('visible');
    clearTimeout(timer);
    timer = setTimeout(() => element.classList.remove('visible'), 4500);
  };
}
