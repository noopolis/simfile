export const WORLD_OBSERVATION_RECOMMENDATION_UNIT =
  "simfile.observation-recommendation.v1" as const;

/**
 * Recommendation channels are deliberately tiny observation metadata. Their
 * presence can inform an already-running observer but cannot encode a wake,
 * recipient, delivery, request, or authority value.
 */
export const assertWorldObservationRecommendation = (
  components: Readonly<Record<string, number>>,
  unit: string | undefined,
  path: string,
): void => {
  if (unit !== WORLD_OBSERVATION_RECOMMENDATION_UNIT) return;
  if (Object.keys(components).sort().join(",") !== "epoch,reason_code"
    || !Number.isSafeInteger(components.epoch)
    || components.epoch! < 0
    || !Number.isSafeInteger(components.reason_code)
    || components.reason_code! < 1
    || components.reason_code! > 255) {
    throw new TypeError(`${path} must contain bounded observation recommendation metadata`);
  }
};
