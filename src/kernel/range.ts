const RANGE_PATTERN = /^(-?(?:0|(?:[1-9][0-9]*))(?:\.[0-9]+)?)\s*\.\.\s*(-?(?:0|(?:[1-9][0-9]*))(?:\.[0-9]+)?)$/u;

export interface ParsedRange {
  min: number;
  max: number;
}

export const parseRange = (input: string): ParsedRange => {
  const match = input.trim().match(RANGE_PATTERN);
  if (!match) {
    throw new Error(`invalid range literal: ${input}`);
  }

  const min = Number.parseFloat(match[1]);
  const max = Number.parseFloat(match[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error(`invalid range bounds: ${input}`);
  }
  if (min >= max) {
    throw new Error(`range lower bound must be smaller than upper bound: ${input}`);
  }

  return { min, max };
};
