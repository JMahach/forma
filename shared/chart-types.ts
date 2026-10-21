// Calculated values shared by the Python transport, browser storage and drawing.
// A person's name, library identity and note belong to their saved record.
export interface Activation {
  planet: string;
  longitude: number;
  gate: number;
  line: number;
  color?: number;
  tone?: number;
  base?: number;
  speed?: number;
}
export interface ChartActivations {
  personality: readonly Activation[];
  design: readonly Activation[];
}
export interface ChartData {
  source: 'calculated' | 'manual' | 'transit';
  personality: readonly number[];
  design: readonly number[];
  activations?: ChartActivations;
  utc?: string;
  timezone?: string;
  utcOffset?: string;
  fold?: number;
  designUtc?: string | null;
  designArcResidualDegrees?: number | null;
  engine?: string;
  ephemeris?: string;
  timezoneDatabase?: string;
  nodeModel?: string;
  zodiac?: string;
  verification?: unknown;
  localDate?: string;
  localTime?: string;
}
export interface CalculatedChart extends ChartData {
  source: 'calculated';
  activations: ChartActivations;
  utc: string;
  timezone: string;
  designUtc: string;
  designArcResidualDegrees: number;
}

export interface City {
  id: string | number;
  name: string;
  country: string;
  region: string;
  timezone: string;
  latitude: number;
  longitude: number;
}
export interface ChartRecord extends ChartData {
  id: string | null;
  name: string;
  birthDate: string;
  birthTime: string;
  birthPlace: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  cityId?: string | number | null;
  city?: Partial<City> | null;
}
export type SavedChart = ChartRecord & { id: string };
export interface CalculationError { error: string; message: string; [detail: string]: unknown }
export interface CalculationRequest {
  mode?: 'natal' | 'transit' | 'transit_design' | 'transit_moment';
  name?: string;
  date?: string;
  time?: string;
  cityId?: string;
  cityName?: string;
  city?: City;
  fold?: number;
  utc?: string;
}
