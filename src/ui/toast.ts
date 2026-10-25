import { createFeedback } from './feedback.ts';
export type Toast = ReturnType<typeof createToast>;
export function createToast(element: HTMLElement) {
  const feedback = createFeedback(element, { kind: 'page' });
  return (message: string) => {
    element.classList.add('visible');
    feedback.show({ message, tone: 'error', actions: [{ label: 'Закрыть', run: () => {
      feedback.clear(); element.classList.remove('visible');
    } }] });
  };
}
