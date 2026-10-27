interface StudioPresentationInput {
  isTransit?: boolean; personalAvailable?: boolean; dayOpened?: boolean;
  lifetime?: { readonly opened: boolean; readonly mode: 'day' | 'lifetime' } | null;
  returnsOpened?: boolean; returnsEnabled?: boolean; transitEnabled?: boolean; loadFailed?: boolean;
}
export type StudioPresentation = ReturnType<typeof studioPresentation>;

// Derived presentation only: no stored state, DOM reads or navigation commands.
// Opening intent can highlight a tool before its lazy panel is ready.
export function studioPresentation({ isTransit = false, personalAvailable = false, dayOpened = false,
  lifetime = null, returnsOpened = false, returnsEnabled = false, transitEnabled = false, loadFailed = false }: StudioPresentationInput) {
  const personalTimelineVisible = Boolean(personalAvailable && lifetime?.opened && lifetime.mode === 'lifetime' && !dayOpened);
  return {
    personalTimelineVisible,
    returnsVisible: personalTimelineVisible && returnsOpened,
    lifetimeAvailable: isTransit || personalAvailable,
    lifetimeHeadingVisible: !personalAvailable,
    timelinePanel: dayOpened ? 'natal-day' : lifetime?.opened ? 'lifetime' : isTransit ? 'transit' : null,
    timelineKind: dayOpened ? 'natal-day' : lifetime?.opened && !personalAvailable ? 'chronicle' : 'day',
    toggleEnabled: personalAvailable ? returnsEnabled : transitEnabled,
    toggleLabel: loadFailed ? 'Обновить страницу и загрузить летопись' : personalAvailable ? 'Возвраты' : 'Летопись',
  } as const;
}
