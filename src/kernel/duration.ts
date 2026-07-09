const DURATION_PATTERN = /^(-?(?:0|(?:[1-9][0-9]*))(?:\.[0-9]+)?)\s*(ms|s|m|h|d|w)$/u;

const MILLIS_PER = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000
} as const;

export interface ParsedDuration {
  value: number;
  unit: "ms" | "s" | "m" | "h" | "d" | "w";
  milliseconds: number;
}

const assertFinitePositive = (value: number): void => {
  if (!Number.isFinite(value)) {
    throw new Error("duration must be a finite number");
  }
};

export const parseDurationMs = (input: string): number => {
  const match = input.trim().match(DURATION_PATTERN);
  if (!match) {
    throw new Error(`invalid duration literal: ${input}`);
  }

  const raw = Number.parseFloat(match[1]);
  assertFinitePositive(raw);
  if (raw < 0) {
    throw new Error(`duration must be non-negative: ${input}`);
  }

  const unit = match[2] as keyof typeof MILLIS_PER;
  return raw * MILLIS_PER[unit];
};

export const parseDuration = (input: string): ParsedDuration => {
  const match = input.trim().match(DURATION_PATTERN);
  if (!match) {
    throw new Error(`invalid duration literal: ${input}`);
  }

  const value = Number.parseFloat(match[1]);
  assertFinitePositive(value);
  if (value < 0) {
    throw new Error(`duration must be non-negative: ${input}`);
  }

  const unit = match[2] as keyof typeof MILLIS_PER;
  const milliseconds = value * MILLIS_PER[unit];
  return { value, unit, milliseconds };
};

export const parseDurationSeconds = (input: string): number => {
  return parseDurationMs(input) / 1_000;
};
