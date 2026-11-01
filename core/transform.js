/**
 * The transform of a cell.
 *
 * A cell may sit somewhere else than it was drawn: moved, made bigger or
 * smaller, and turned. Clip Studio Paint keeps this in the curves of the
 * track of the cell - `ImagePosition`, `ImageScale` and `ImageRotation` -
 * and a part of a puppet animation is moved with it from one frame to the
 * next.
 *
 * The picture turns and grows around the middle of the canvas, the way the
 * camera does, and the position says how far the picture is from that
 * middle. The scale is a factor: 1 is the size the picture was drawn at.
 */

/** The transform of a cell that has not been moved. */
export const IDENTITY_TRANSFORM = Object.freeze({ x: 0, y: 0, scale: 1, rotation: 0 });

/** The transform of a drawing, or the one that means "as it was drawn". */
export function transformOf(drawing) {
  const transform = drawing?.transform;
  if (!transform || typeof transform !== "object") return IDENTITY_TRANSFORM;
  const scale = Number(transform.scale);
  const result = {
    x: Number(transform.x) || 0,
    y: Number(transform.y) || 0,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    rotation: Number(transform.rotation) || 0,
  };
  // Where a motion tween turns the picture from - the point its placement
  // keeps still, carried so a painted picture turns around the same point.
  const pivotX = Number(transform.pivotX);
  const pivotY = Number(transform.pivotY);
  if (Number.isFinite(pivotX) && Number.isFinite(pivotY)) {
    result.pivotX = pivotX;
    result.pivotY = pivotY;
  }
  return result;
}

/** Whether the transform says nothing at all. */
export function isPlain(transform) {
  return (
    transform.x === 0 &&
    transform.y === 0 &&
    transform.scale === 1 &&
    transform.rotation === 0
  );
}

/**
 * The transform a drawing shows on a frame of its hold.
 *
 * A cell may tween: the transform it says is the state of the picture at the
 * frame the cell starts on, and the one its `tween` says has to be reached
 * by the time the span of the cell is over - the way Flash 8 moves a cell
 * with a motion tween. Between the two ends the transform walks the span:
 * on the frame the span starts it is the start exactly, and it would be the
 * end on the frame just past the span, where the next cell of the layer
 * picks the walk up. A cell without a tween is just the transform it says.
 */
export function transformAt(drawing, frame) {
  const tween = drawing?.tween;
  if (!tween || typeof tween !== "object") return transformOf(drawing);
  const start = drawing.transform ?? IDENTITY_TRANSFORM;
  const hold = drawing?.hold ?? 0;
  const at = drawing?.at ?? 0;
  const progress = hold > 0 && Number.isFinite(frame) ? (frame - at) / hold : 1;
  // The pace of the walk. A tween that carries a custom ease curve - the one
  // Flash 8 records for a span - walks that curve; without one the walk is at
  // even pace.
  const p = easedProgress(tween.ease, Math.max(0, Math.min(1, progress)));
  const mix = (a, b) => a + (b - a) * p;
  const scale = mix(start.scale, Number(tween.scale) || 1);
  const transform = {
    x: mix(start.x, Number(tween.x) || 0),
    y: mix(start.y, Number(tween.y) || 0),
    scale: scale > 0 ? scale : 1,
    rotation: mix(start.rotation, Number(tween.rotation) || 0),
  };
  // A tween of an imported .fla remembers where the point the picture is
  // placed by sat when the span started (`pivotX`/`pivotY`, canvas pixels).
  // Flash slides that point along a straight line and turns and grows the
  // picture around it, so the walk has to carry it along. A tween saved
  // before the pivot was known says only where the middle of the picture was
  // (`startX`/`startY`); that is a close stand-in.
  const pivotX = Number(tween.pivotX ?? tween.startX);
  const pivotY = Number(tween.pivotY ?? tween.startY);
  if (Number.isFinite(pivotX) && Number.isFinite(pivotY)) {
    transform.pivotX = pivotX;
    transform.pivotY = pivotY;
  }
  return transform;
}

/**
 * How far a walk has come at `t` of the span, 0 to 1.
 *
 * `ease` is a chain of cubic bezier pieces across the unit square, the shape
 * Flash 8 records for a custom ease: x is the time of the span, y is how far
 * the walk has come. Each piece is four points - the start, two handles and
 * the end - with the end of one piece being the start of the next. The walk
 * reads the curve: at time `t` it takes the piece that covers `t`, slides
 * along it until its x is `t`, and answers with that point's y.
 */
function easedProgress(ease, t) {
  if (!Array.isArray(ease) || ease.length < 4) return t;
  const pieces = [];
  // Pieces share their end point with the next piece's start; the final
  // point of the chain is the end of the last piece.
  for (let at = 0; at <= ease.length - 3; at += 3) {
    pieces.push([ease[at], ease[at + 1], ease[at + 2], ease[at + 3] ?? [1, 1]]);
  }
  if (!pieces.length) return t;
  let piece = pieces[pieces.length - 1];
  for (const candidate of pieces) {
    if (t <= candidate[3][0] + 1e-12) {
      piece = candidate;
      break;
    }
  }
  const [p0, p1, p2, p3] = piece;
  const at = (u) => {
    const w = 1 - u;
    return {
      x: w * w * w * p0[0] + 3 * w * w * u * p1[0] + 3 * w * u * u * p2[0] + u * u * u * p3[0],
      y: w * w * w * p0[1] + 3 * w * w * u * p1[1] + 3 * w * u * u * p2[1] + u * u * u * p3[1],
    };
  };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (at(mid).x < t) lo = mid;
    else hi = mid;
  }
  return at((lo + hi) / 2).y;
}

/**
 * The point a transform turns and grows around.
 *
 * A cell that came from a motion tween of a `.fla` turns around the middle of
 * its own picture, which the tween remembers in `startX`/`startY`: the
 * strokes of the cell are already placed where they sat at the start of the
 * span, so their middle is the point Flash keeps in place while the picture
 * turns and grows. Everything else turns around the middle of the canvas, the
 * way the camera does.
 */
function pivotOf(transform, width, height) {
  const x = Number(transform?.pivotX);
  const y = Number(transform?.pivotY);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  return { x: width / 2, y: height / 2 };
}

/**
 * The matrix that puts a picture where the transform says.
 *
 * The numbers are the ones a canvas wants: `a`, `b`, `c`, `d`, `e` and `f`
 * of `setTransform`.
 */
export function transformMatrix(transform, width, height) {
  const { x, y, scale, rotation } = transform;
  const angle = (rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const pivot = pivotOf(transform, width, height);
  return {
    a: scale * cos,
    b: scale * sin,
    c: -scale * sin,
    d: scale * cos,
    e: pivot.x + x - scale * (cos * pivot.x - sin * pivot.y),
    f: pivot.y + y - scale * (sin * pivot.x + cos * pivot.y),
  };
}

/**
 * A point of the canvas back in the space of the picture.
 *
 * The brush works in the space of the picture, so a point under the pointer
 * has to be put back into it before the ink is put down.
 */
export function pointToPicture(point, transform, width, height) {
  const { x, y, scale, rotation } = transform;
  const angle = (rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const pivot = pivotOf(transform, width, height);
  const dx = point.x - pivot.x - x;
  const dy = point.y - pivot.y - y;
  return {
    x: pivot.x + (cos * dx + sin * dy) / scale,
    y: pivot.y + (-sin * dx + cos * dy) / scale,
  };
}

/**
 * The matrix that says nothing at all.
 */
export function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

/**
 * The matrix of several transforms, one after the other.
 *
 * A layer may have a transform of its own and a cell may have one as well,
 * and the picture of the cell is moved by both.
 */
export function composeMatrix(transforms, width, height) {
  let matrix = identityMatrix();
  for (const transform of transforms) {
    if (!transform || isPlain(transform)) continue;
    const next = transformMatrix(transform, width, height);
    matrix = {
      a: matrix.a * next.a + matrix.c * next.b,
      b: matrix.b * next.a + matrix.d * next.b,
      c: matrix.a * next.c + matrix.c * next.d,
      d: matrix.b * next.c + matrix.d * next.d,
      e: matrix.a * next.e + matrix.c * next.f + matrix.e,
      f: matrix.b * next.e + matrix.d * next.f + matrix.f,
    };
  }
  return matrix;
}

/**
 * Put a picture where a matrix says, in pixels.
 *
 * The exports have no canvas to draw on, so the picture is turned and grown
 * here: every pixel of the result takes the colour of the pixel of the
 * picture it came from, mixed with its neighbours when it falls between
 * them.
 *
 * @param {Uint8Array} rgba The picture, four bytes a pixel.
 * @param {number} width The width of the picture.
 * @param {number} height The height of the picture.
 * @param {object} matrix The matrix, as `transformMatrix` gives it.
 * @returns {Uint8Array} The picture, put where the matrix says.
 */
export function transformRgba(rgba, width, height, matrix, interpolation) {
  if (!matrix || (matrix.a === 1 && matrix.b === 0 && matrix.c === 0 && matrix.d === 1 && !matrix.e && !matrix.f)) {
    return rgba;
  }
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!determinant) return rgba;

  let out;
  if (interpolation === "nearest") {
    // Nearest-neighbour: every result pixel takes the closest source pixel.
    out = new Uint8Array(rgba.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dx = x - matrix.e;
        const dy = y - matrix.f;
        const sourceX = (matrix.d * dx - matrix.c * dy) / determinant;
        const sourceY = (-matrix.b * dx + matrix.a * dy) / determinant;
        const sx = Math.floor(sourceX + 0.5);
        const sy = Math.floor(sourceY + 0.5);
        if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
          const target = (y * width + x) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            out[target + channel] = rgba[(sy * width + sx) * 4 + channel];
          }
        }
      }
    }
  } else {
    // Bilinear (default): every result pixel takes a weighted mix of the 4
    // surrounding source pixels.
    out = new Uint8Array(rgba.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dx = x - matrix.e;
        const dy = y - matrix.f;
        const sourceX = (matrix.d * dx - matrix.c * dy) / determinant;
        const sourceY = (-matrix.b * dx + matrix.a * dy) / determinant;
        const target = (y * width + x) * 4;
        if (sourceX < 0 || sourceY < 0 || sourceX > width - 1 || sourceY > height - 1) {
          continue;
        }
        const left = Math.floor(sourceX);
        const top = Math.floor(sourceY);
        const right = Math.min(left + 1, width - 1);
        const bottom = Math.min(top + 1, height - 1);
        const along = sourceX - left;
        const down = sourceY - top;
        for (let channel = 0; channel < 4; channel += 1) {
          const topLeft = rgba[(top * width + left) * 4 + channel];
          const topRight = rgba[(top * width + right) * 4 + channel];
          const bottomLeft = rgba[(bottom * width + left) * 4 + channel];
          const bottomRight = rgba[(bottom * width + right) * 4 + channel];
          const upper = topLeft + (topRight - topLeft) * along;
          const lower = bottomLeft + (bottomRight - bottomLeft) * along;
          out[target + channel] = Math.round(upper + (lower - upper) * down);
        }
      }
    }
  }
  return out;
}
