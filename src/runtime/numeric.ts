export interface RangeSpec {
  min: number;
  max: number;
}

export const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

export const clampAndRound = (value: number, range: RangeSpec, precision: number): number => {
  const rounded = Number(finite(value).toFixed(precision));
  if (rounded < range.min) {
    return range.min;
  }
  if (rounded > range.max) {
    return range.max;
  }
  return rounded === -0 ? 0 : rounded;
};
