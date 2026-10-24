// Read all painted lanes belonging to a gate, independent of paint-pass order.
export function integrationArmMarkup(markup: string, gate: string | number) {
  return [...markup.matchAll(new RegExp(`<g data-integration-layer="${gate}"[^>]*>([\\s\\S]*?)<\\/g>`, 'g'))]
    .map(match => match[1]).join('');
}
