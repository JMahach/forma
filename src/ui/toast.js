export function createToast(element) {
  let timer;
  return message => {
    element.textContent = message;
    element.classList.add('visible');
    clearTimeout(timer);
    timer = setTimeout(() => element.classList.remove('visible'), 4500);
  };
}
