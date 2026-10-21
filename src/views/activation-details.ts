import type { Activation } from '../../shared/chart-types.ts';
import { activationSubstructure } from '../domain/substructure.ts';

const LABELS = [['gate', 'Ворота'], ['line', 'Линия'], ['color', 'Цвет'], ['tone', 'Тон'], ['base', 'База']] as const;

// The popup presents the domain's numeric result; it owns no longitude rules.
export function activationDetails(entry: Activation | null | undefined) {
  const structure = activationSubstructure(entry);
  return structure && LABELS.map(([key, label]) => ({ key, label, value: structure[key], percent: structure.percent[key] }));
}
