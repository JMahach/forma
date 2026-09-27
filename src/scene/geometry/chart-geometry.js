import { canonicalChannelId } from '../../domain/topology.js';
import { CENTERS as CENTER_CATALOG, GATES as GATE_CATALOG, CHANNELS as CHANNEL_CATALOG } from '../../reference/catalog.js';

// Original coordinates in the project's 640 × 820 SVG space.
const centerGeometry = {
  head: { points: "320,40 268,122 372,122", labelX: 320, labelY: 86 },
  ajna: { points: "268,146 372,146 320,228", labelX: 320, labelY: 186 },
  throat: { points: "273.2,256 366.8,256 366.8,352 273.2,352", labelX: 320, labelY: 304 },
  g: { points: "320,374.4 381.6,436 320,497.6 258.4,436", labelX: 320, labelY: 436 },
  heart: { points: "434,408 392,476 476,476", labelX: 434, labelY: 447 },
  spleen: { points: "104,528 208,588 104,648", labelX: 140, labelY: 588 },
  solar: { points: "536,528 432,588 536,648", labelX: 500, labelY: 588 },
  sacral: { points: "273.2,528 366.8,528 366.8,624 273.2,624", labelX: 320, labelY: 576 },
  root: { points: "273.2,660 366.8,660 366.8,756 273.2,756", labelX: 320, labelY: 708 },
};
const gatePositions = {
  1: [320, 397.5],
  2: [320, 477.8],
  3: [320, 608],
  4: [341, 156],
  5: [299, 544],
  6: [455, 588],
  7: [299, 418.4],
  8: [320, 340],
  9: [341, 608],
  10: [282.6, 436],
  11: [341, 176.5],
  12: [356, 302],
  13: [341, 418.4],
  14: [320, 544],
  15: [299, 453.6],
  16: [284, 280],
  17: [299, 176.5],
  18: [118, 626],
  19: [356, 696],
  20: [284, 302],
  21: [434, 433],
  22: [499, 563],
  23: [320, 266.5],
  24: [320, 156],
  25: [357.4, 436],
  26: [434, 463],
  27: [284, 588],
  28: [141, 613],
  29: [341, 544],
  30: [522, 626],
  31: [299, 340],
  32: [164, 600],
  33: [341, 340],
  34: [284, 566],
  35: [356, 280],
  36: [522, 550],
  37: [476, 576],
  38: [284, 718],
  39: [356, 718],
  40: [455, 461],
  41: [356, 740],
  42: [299, 608],
  43: [320, 209],
  44: [164, 576],
  45: [356, 324],
  46: [341, 453.6],
  47: [299, 156],
  48: [118, 550],
  49: [476, 600],
  50: [185, 588],
  51: [413, 461],
  52: [341, 676],
  53: [299, 676],
  54: [284, 696],
  55: [499, 613],
  56: [341, 266.5],
  57: [141, 563],
  58: [284, 740],
  59: [356, 588],
  60: [320, 676],
  61: [320, 106],
  62: [299, 266.5],
  63: [341, 106],
  64: [299, 106],
};
const channelControls = {
  "16-48": [176, 292, 118, 428],
  "20-57": [186, 317, 141, 443],
  "20-34": [208, 448, 223, 576],
  "10-20": [229, 400, 232, 465],
  "35-36": [464, 292, 522, 428],
  "12-22": [454, 317, 499, 443],
  "21-45": [396, 324, 434, 382],
  "10-57": [204, 475, 166, 488],
  "10-34": [240, 536, 254, 588],
  "34-57": [236, 583, 177, 551],
  "25-51": [380, 436, 389, 461],
  "26-44": [198, 520, 216, 510, 260, 510, 340, 510, 434, 524],
  "37-40": [476, 532, 455, 506],
  "18-58": [118, 698, 184, 740],
  "28-38": [141, 680, 196, 718],
  "32-54": [164, 662, 208, 696],
  "19-49": [432, 696, 476, 662],
  "39-55": [444, 718, 499, 680],
  "30-41": [456, 740, 522, 698],
};

export const CENTERS = CENTER_CATALOG.map(center => ({ ...center, ...centerGeometry[center.id] }));
export const GATES = GATE_CATALOG.map(gate => ({ ...gate, x: gatePositions[gate.id][0], y: gatePositions[gate.id][1] }));
const gatesById = new Map(GATES.map(gate => [gate.id, gate]));
const centersById = new Map(CENTERS.map(center => [center.id, center]));
export const getGate = id => gatesById.get(Number(id));
export const getCenter = id => centersById.get(id);

function channelGeometry(channel) {
  const [a,b] = channel.gates, start = getGate(a), end = getGate(b);
  const control = channelControls[channel.id] || [
    start.x + (end.x - start.x) / 3, start.y + (end.y - start.y) / 3,
    start.x + (end.x - start.x) * 2 / 3, start.y + (end.y - start.y) * 2 / 3,
  ];
  const points = [[start.x, start.y], ...Array.from({ length: control.length / 2 }, (_, i) => control.slice(i * 2, i * 2 + 2)), [end.x, end.y]];
  const curves = [];
  for (let i = 1; i < points.length; i += 3) curves.push(points.slice(i - 1, i + 3));
  return { ...channel, curve: curves[0], curves,
    path: `M ${start.x} ${start.y} ${curves.map(curve => `C ${curve.slice(1).flat().join(' ')}`).join(' ')}` };
}
export const CHANNELS = CHANNEL_CATALOG.map(channelGeometry);
const channelsById = new Map(CHANNELS.map(channel => [channel.id, channel]));
export const getChannel = id => channelsById.get(canonicalChannelId(id));
