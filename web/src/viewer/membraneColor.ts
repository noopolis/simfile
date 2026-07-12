/**
 * A membrane's rendered color — "the ambassador body wearing its home
 * container's color" (`VIEW_DESIGN.md`'s crossing vocabulary, "representative").
 * Deterministic (seeded by the membrane's own `ref`, never random — replay
 * determinism, `VIEW_DESIGN.md`'s testing strategy), so the same run always
 * paints `team:luna` the same hue across the map, the outer chat's boundary
 * badge, and the interior portal header. Pure presentation: no schema key
 * carries this (rule 4), and it is derived from an id the world already has,
 * not invented state.
 */

const HUE_STEP = 137.508; // golden-angle spacing keeps adjacent membrane ids visually distinct

const hashToUnit = (value: string): number => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash / 0xffffffff;
};

/** An `hsl(...)` string for a membrane ref, stable across calls and across a run's replay. */
export const membraneColor = (membraneRef: string): string => {
  const hue = Math.round((hashToUnit(membraneRef) * 360 + HUE_STEP) % 360);
  return `hsl(${hue}, 62%, 58%)`;
};
