/**
 * Pulled-string stabilizer for freedraw: the brush is tied to the pointer by
 * a string and only moves once the pointer pulls it taut, so jitter within
 * the string's length never reaches the stroke and corners are rounded off.
 */

/** Longest string (screen px) the stabilizer setting allows. */
export const MAX_STABILIZER_STRING_LENGTH = 200;

export type StabilizerPoint = { x: number; y: number };

/**
 * The string length in scene units for the setting, a length in screen px,
 * so the string feels the same at any zoom. 0 turns the stabilizer off.
 */
export const getStabilizerStringLength = (lengthPx: number, zoom: number) =>
  lengthPx / zoom;

/**
 * Where the brush moves to as the pointer reaches `pointer`, or `null` while
 * the string is slack and the brush stays put.
 */
export const pullStabilizerBrush = (
  brush: StabilizerPoint,
  pointer: StabilizerPoint,
  stringLength: number,
): StabilizerPoint | null => {
  const dx = pointer.x - brush.x;
  const dy = pointer.y - brush.y;
  const distance = Math.hypot(dx, dy);

  if (distance <= stringLength) {
    return null;
  }

  // the brush follows along the string, keeping it exactly taut
  const pull = (distance - stringLength) / distance;
  return { x: brush.x + dx * pull, y: brush.y + dy * pull };
};

/** How far apart (screen px) the pointer path is sampled between events. */
const STABILIZER_STEP_PX = 2;

/**
 * Pulls the brush along the pointer's path from `from` to `to` in small steps
 * rather than in one jump, so the brush traces a smooth curve even though the
 * browser only reports pointer samples once per frame. Returns the positions
 * the brush passed through, each with `t`, how far along the path (0–1) it
 * was pulled there, for interpolating pressure.
 */
export const pullStabilizerBrushAlong = (
  brush: StabilizerPoint,
  from: StabilizerPoint,
  to: StabilizerPoint,
  stringLength: number,
  zoom: number,
): (StabilizerPoint & { t: number })[] => {
  const step = STABILIZER_STEP_PX / zoom;
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step),
  );

  const path: (StabilizerPoint & { t: number })[] = [];
  let emitted = brush;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const pulled = pullStabilizerBrush(
      brush,
      { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
      stringLength,
    );
    if (!pulled) {
      continue;
    }
    brush = pulled;

    // keep points about a step apart, plus where the brush ends up
    if (
      i === steps ||
      Math.hypot(brush.x - emitted.x, brush.y - emitted.y) >= step
    ) {
      path.push({ ...brush, t });
      emitted = brush;
    }
  }

  // the brush can stop on a slack substep; it must still end up recorded
  if (emitted !== brush) {
    path.push({ ...brush, t: 1 });
  }

  return path;
};
