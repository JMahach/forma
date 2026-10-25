import type { KnowledgeEntry } from '../reference/knowledge-content.ts';
import { knowledgeSelectionForEntry } from '../reference/knowledge-catalog.ts';
import { CENTERS, GATES, CHANNELS } from '../scene/geometry/chart-geometry.ts';
import { channelHalves, INTEGRATION_ARMS, pointString, roundedCenter } from '../scene/geometry/drawing-geometry.ts';
import { GATE_MARKER, CENTER_STROKE, CHANNEL_WIDTH } from '../scene/geometry/drawing-presentation.ts';
import { createGateLabelRenderer } from '../scene/gate-label.ts';
import { PALETTE } from '../ui/chart-palette.ts';
import { escapeHtml as escape } from '../ui/html.ts';

// A local crop of studio coordinates. Selected black paint is a reading aid,
// owned by data-selected/CSS, rather than a claim about a personal birth chart.
export function renderKnowledgeCenterFigure(entry: KnowledgeEntry, selectedGate: number | null = null): string {
  if (entry.kind !== 'center') return '';
  const selection = knowledgeSelectionForEntry(entry);
  const center = CENTERS.find(item => item.id === selection?.id);
  if (!center) return '';
  const gateLabel = createGateLabelRenderer();
  const gates = GATES.filter(gate => gate.center === center.id);
  const points = center.points.split(' ').map(pair => pair.split(',').map(Number));
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const margin = 40;
  const x = Math.min(...xs) - margin, y = Math.min(...ys) - margin;
  const width = Math.max(...xs) - x + margin, height = Math.max(...ys) - y + margin;
  const color = PALETTE[center.id as keyof typeof PALETTE];
  const branches = gates.map(gate => {
    const arm = INTEGRATION_ARMS.find(arm => arm.gate === gate.id);
    // Integration's three logical channels share one anatomical port. Never
    // overlay the legacy individual channel curves at that shared fork.
    const channel = arm ? undefined : CHANNELS.find(channel => channel.gates.includes(gate.id));
    if (!arm && !channel) return '';
    const background = arm?.path ?? channel!.path;
    const active = arm?.path ?? pointString(channelHalves.get(channel!.id)![channel!.gates.indexOf(gate.id)]);
    return `<g class="knowledge-center-branch" data-gate-id="${gate.id}" data-selected="${gate.id === selectedGate}">
      <path class="knowledge-center-channel-outline" d="${background}" fill="none" stroke="${PALETTE.outline}" stroke-width="${CHANNEL_WIDTH.outline}" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>
      <path class="knowledge-center-channel" d="${background}" fill="none" stroke="${PALETTE.paper}" stroke-width="${CHANNEL_WIDTH.paint}" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>
      <path class="knowledge-center-channel-active" d="${active}" fill="none" stroke="${PALETTE.ink}" stroke-width="${CHANNEL_WIDTH.paint}" stroke-linecap="butt" stroke-linejoin="round" opacity="0" pointer-events="none"/>
    </g>`;
  }).join('');
  return `<figure class="knowledge-center-figure" style="--knowledge-center-color: ${color}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}" overflow="hidden" role="group" aria-label="${escape(entry.title)}: ворота и выходящие связи" preserveAspectRatio="xMidYMid meet">
    ${branches}
    <path class="knowledge-center-outline" d="${roundedCenter(center.points)}" fill="${color}" stroke="#84715b" stroke-width="${CENTER_STROKE}" stroke-linejoin="round"/>
    ${gates.map(gate => `<g class="knowledge-center-gate" data-entry-id="gate.${gate.id}" data-gate-id="${gate.id}" data-selected="${gate.id === selectedGate}" tabindex="0" role="button" aria-pressed="${gate.id === selectedGate}" aria-label="Ворота ${gate.id}: ${escape(gate.name)}" transform="translate(${gate.x} ${gate.y})">
      <circle class="knowledge-center-hit" r="${GATE_MARKER.hitRadius}" fill="transparent"/>
      <circle class="knowledge-center-disc" r="${GATE_MARKER.radius}" fill="transparent" stroke="none" pointer-events="none"/>
      ${gateLabel(gate.id, '#171513')}
    </g>`).join('')}
  </svg><figcaption>Выберите ворота, чтобы увидеть связи</figcaption></figure>`;
}
