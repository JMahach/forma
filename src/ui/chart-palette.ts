// Shared flat chart colors for the drawing and its interface references.
export const PALETTE = {
  ink: '#202020', design: '#c32d35', outline: '#c6c2b9', paper: '#ffffff',
  halo: '#91bce9',
  // Traditional center families, with flat colors rather than decorative fills.
  // Reference: jovianarchive.com/blogs/human-design-basics/the-9-centers-in-human-design
  head: '#edcd4c', ajna: '#79a367', throat: '#b58a60', g: '#edcd4c',
  heart: '#da514b', spleen: '#b58a60', solar: '#b58a60', sacral: '#da514b', root: '#b58a60',
};

// Column feedback keeps the map hue; its fill is half the previous 2/3 density.
export const ACTIVATION_HIGHLIGHT_OPACITY = 1 / 3;

// Pinned map feedback is the same blue, with each sRGB channel 10% darker.
export const SELECTED_HIGHLIGHT_COLOR = '#' + PALETTE.halo.slice(1).match(/../g)!
  .map(channel => Math.round(parseInt(channel, 16) * .9).toString(16).padStart(2, '0')).join('');
