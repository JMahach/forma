import { activationSubstructure } from '../domain/substructure.js';

const LABELS = [['gate', 'Ворота'], ['line', 'Линия'], ['color', 'Цвет'], ['tone', 'Тон'], ['base', 'База']];

// The popup presents the domain's numeric result; it owns no longitude rules.
export function activationDetails(entry) {
  const structure = activationSubstructure(entry);
  return structure && LABELS.map(([key, label]) => ({ key, label, value: structure[key], percent: structure.percent[key] }));
}
