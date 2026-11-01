/**
 * The maths of the colour wheel of the tool panel: a ring of hues with a
 * saturation/value square in the middle.
 *
 * The ring is **drawn** with the arc of a hue at the canvas angle of that
 * hue: 0 is the right hand side (3 o'clock) and the angles grow clockwise,
 * because the y axis of a canvas points down. So the point that is **picked**
 * has to read its hue at that same angle, or the marker of the ring lands a
 * quarter turn away from the arc under the cursor and the colour that comes
 * out is not the colour of the arc that was clicked.
 *
 * The maths lives in its own file because it is the one part of the wheel
 * that has to be right, and because it can be measured without a browser.
 */

/** The size of the canvas of the wheel, in the pixels of the screen. */
export const WHEEL_SIZE = 176;

/** The width of the ring, in the pixels of the canvas. */
const RING_WIDTH = 24;

/**
 * The shape of the wheel.
 *
 * The square is inscribed in the ring: its corner reaches the inner edge of
 * the ring, so the two touch without ever overlapping.
 *
 * @param {number} size The size of the canvas of the wheel.
 * @returns {object} The centre, the ring and the square of the wheel.
 */
export function wheelLayout(size = WHEEL_SIZE) {
  const centre = size / 2;
  const ringOuter = centre;
  const ringInner = centre - RING_WIDTH;
  const svHalf = Math.floor(ringInner * Math.SQRT1_2) - 1;
  return {
    size,
    centre,
    ringOuter,
    ringInner,
    ringMiddle: (ringOuter + ringInner) / 2,
    svHalf,
    side: svHalf * 2,
    squareX: centre - svHalf,
    squareY: centre - svHalf,
  };
}

/** A number between 0 and 1. */
function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * The hue under a point of the ring, in degrees.
 *
 * The angle is the one the ring is drawn with, so the hue that is read here
 * is the hue of the arc that is under the point.
 *
 * @param {number} x The x of the point, in the pixels of the canvas.
 * @param {number} y The y of the point, in the pixels of the canvas.
 * @param {object} layout The shape of the wheel.
 * @returns {number} The hue, from 0 to 360.
 */
export function hueAtPoint(x, y, layout = wheelLayout()) {
  const degrees = (Math.atan2(y - layout.centre, x - layout.centre) * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

/**
 * Where the marker of the ring sits for a hue.
 *
 * @param {number} hue The hue, in degrees.
 * @param {object} layout The shape of the wheel.
 * @returns {{x: number, y: number}} The point of the marker.
 */
export function huePoint(hue, layout = wheelLayout()) {
  const angle = ((((hue % 360) + 360) % 360) * Math.PI) / 180;
  return {
    x: layout.centre + layout.ringMiddle * Math.cos(angle),
    y: layout.centre + layout.ringMiddle * Math.sin(angle),
  };
}

/**
 * The saturation and the value under a point of the square.
 *
 * The square runs from white on the left to the pure hue on the right, and
 * from the pure hue at the top to black at the bottom, so the saturation is
 * read along x and the value along y.
 *
 * @param {number} x The x of the point, in the pixels of the canvas.
 * @param {number} y The y of the point, in the pixels of the canvas.
 * @param {object} layout The shape of the wheel.
 * @returns {{saturation: number, value: number}} The saturation and the value.
 */
export function svAtPoint(x, y, layout = wheelLayout()) {
  const dx = x - layout.centre;
  const dy = y - layout.centre;
  return {
    saturation: clamp01(dx / layout.side + 0.5),
    value: clamp01(0.5 - dy / layout.side),
  };
}

/**
 * What a point of the wheel holds: the hue of the ring, or the saturation
 * and the value of the square.
 *
 * The square is asked **first**. Its corner reaches the inner edge of the
 * ring, so a click near that corner is a click in the square and not a
 * click in the ring - otherwise the hue would change when the saturation
 * was wanted.
 *
 * @param {number} x The x of the point, in the pixels of the canvas.
 * @param {number} y The y of the point, in the pixels of the canvas.
 * @param {object} layout The shape of the wheel.
 * @returns {{region: string, hue?: number, saturation?: number, value?: number}}
 *   The part of the wheel the point is on.
 */
export function wheelPick(x, y, layout = wheelLayout()) {
  const dx = x - layout.centre;
  const dy = y - layout.centre;
  if (Math.abs(dx) <= layout.svHalf && Math.abs(dy) <= layout.svHalf) {
    return { region: "square", ...svAtPoint(x, y, layout) };
  }
  const radius = Math.hypot(dx, dy);
  if (radius >= layout.ringInner - 2 && radius <= layout.ringOuter + 2) {
    return { region: "ring", hue: hueAtPoint(x, y, layout) };
  }
  return { region: "none" };
}

/**
 * The colour of a hue, a saturation and a value.
 *
 * @param {number} h The hue, in degrees.
 * @param {number} s The saturation, from 0 to 1.
 * @param {number} v The value, from 0 to 1.
 * @returns {Array<number>} The red, green and blue, from 0 to 255.
 */
export function hsvToRgb(h, s, v) {
  const sector = ((((h % 360) + 360) % 360) / 60);
  const c = v * s;
  const x = c * (1 - Math.abs((sector % 2) - 1));
  const m = v - c;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][Math.floor(sector) % 6];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * The hue, the saturation and the value of a colour.
 *
 * A grey has no hue of its own: its hue comes back as 0, and the caller is
 * the one that decides whether to keep the hue it had.
 *
 * @param {number} r The red, from 0 to 255.
 * @param {number} g The green, from 0 to 255.
 * @param {number} b The blue, from 0 to 255.
 * @returns {Array<number>} The hue in degrees, the saturation and the value.
 */
export function rgbToHsv(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === red) h = 60 * (((green - blue) / delta) % 6);
    else if (max === green) h = 60 * ((blue - red) / delta + 2);
    else h = 60 * ((red - green) / delta + 4);
  }
  return [((h % 360) + 360) % 360, max === 0 ? 0 : delta / max, max];
}
