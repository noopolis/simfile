import { createHash } from "node:crypto";

const TWO_POW_53 = 2 ** 53;

export interface UniformDrawInput {
  runSeed: string;
  generatorId: string;
  tick: number;
  drawIndex: number;
  min: number;
  max: number;
}

const normalizeSeed = (value: string): string => value.trim();

const sampleUnitInterval = (input: string): number => {
  const digest = createHash("sha256").update(input, "utf8").digest();
  const value = Number(digest.readBigUInt64BE(0) >> 11n) / TWO_POW_53;
  return value;
};

export const drawUniform = ({
  runSeed,
  generatorId,
  tick,
  drawIndex,
  min,
  max
}: UniformDrawInput): number => {
  if (!Number.isFinite(tick) || !Number.isInteger(tick) || tick < 0) {
    throw new Error(`tick must be a non-negative integer: ${tick}`);
  }
  if (!Number.isFinite(drawIndex) || !Number.isInteger(drawIndex) || drawIndex < 0) {
    throw new Error(`drawIndex must be a non-negative integer: ${drawIndex}`);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error("distribution bounds must be finite numbers");
  }
  if (max < min) {
    throw new Error(`max must be >= min: ${min}..${max}`);
  }

  const key = `${normalizeSeed(runSeed)}:${normalizeSeed(generatorId)}:${tick}:${drawIndex}`;
  const unitValue = sampleUnitInterval(key);
  return min + (max - min) * unitValue;
};
