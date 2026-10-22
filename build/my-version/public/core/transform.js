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
  return {
    x: Number(transform.x) || 0,
    y: Number(transform.y) || 0,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    rotation: Number(transform.rotation) || 0,
  };
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
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return {
    a: scale * cos,
    b: scale * sin,
    c: -scale * sin,
    d: scale * cos,
    e: halfWidth + x - scale * (cos * halfWidth - sin * halfHeight),
    f: halfHeight + y - scale * (sin * halfWidth + cos * halfHeight),
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
  const dx = point.x - width / 2 - x;
  const dy = point.y - height / 2 - y;
  return {
    x: width / 2 + (cos * dx + sin * dy) / scale,
    y: height / 2 + (-sin * dx + cos * dy) / scale,
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
