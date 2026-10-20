/**
 * Onion-skin selection, DOM-free so the browser UI and the tests share it.
 *
 * Onion skins show the drawings neighbouring the current one on a layer,
 * tinted by direction. They follow *drawings*, not frame numbers: a drawing
 * held for ten frames counts once.
 */

export const ONION_MAX = 5;

function clampCount(value) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.min(ONION_MAX, Math.max(0, number));
}

/**
 * Pick the drawings to ghost around `frame`.
 *
 * Returns [{ drawing, side: "before" | "after", step, weight }] where `step`
 * is 1 for the nearest neighbour and `weight` fades from 1 (nearest) toward
 * 1/count (furthest). The drawing that is exposed at `frame` is never
 * returned. Layer behaviours (hold/repeat/pingpong) are ignored on purpose:
 * onion skins show real neighbours only.
 */
export function onionTargets(layer, frame, { before = 1, after = 1 } = {}) {
  const drawings = Array.isArray(layer?.drawings) ? [...layer.drawings] : [];
  if (drawings.length === 0) return [];
  drawings.sort((a, b) => a.at - b.at);

  const countBefore = clampCount(before);
  const countAfter = clampCount(after);

  const previous = drawings.filter((drawing) => drawing.at + drawing.hold - 1 < frame);
  const next = drawings.filter((drawing) => drawing.at > frame);

  const targets = [];
  const nearestFirstBefore =
    countBefore === 0 ? [] : previous.slice(-countBefore).reverse();
  nearestFirstBefore.forEach((drawing, index) => {
    targets.push({
      drawing,
      side: "before",
      step: index + 1,
      weight: (countBefore - index) / countBefore,
    });
  });
  next.slice(0, countAfter).forEach((drawing, index) => {
    targets.push({
      drawing,
      side: "after",
      step: index + 1,
      weight: (countAfter - index) / countAfter,
    });
  });
  return targets;
}
