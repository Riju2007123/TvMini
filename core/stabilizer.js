/**
 * The trailing stabilizer, the way Umoupen builds it.
 *
 * The raw places of the hand go into a ring, and the point that is drawn is
 * the mean of the hand's path over the last moments: a run of the path that
 * is `window` seconds long, weighted by the time the hand spent on every part
 * of it. A wobble of the hand is averaged away, and the line trails a little
 * behind the hand while it does.
 *
 * The window is not a fixed number of samples but a stretch of time, so the
 * calm of the line is the same however fast the pen reports. How long the
 * window is follows the strength of the stabilizer on a curve that rises
 * gently at the bottom of the scale and firmly at the top, and the line never
 * trails further than a limit, however slow the hand moves.
 *
 * When the hand lifts, the stroke is finished at the place of the lift: the
 * points the window was still holding are traced out, so the line ends where
 * the hand ended and not where the lag left it.
 *
 * Nothing here touches the document or the DOM; it is arithmetic on samples.
 */

/** The longest the window ever is, in seconds, at the top of the scale. */
export const STAB_WIN_MAX_S = 0.6;
/** The furthest the drawn point may trail the hand, in pixels. */
export const STAB_MAX_LAG_PX = 150;
/** The share of the window that stays at a resting hand (speed ramp). */
export const STAB_SLOW_FLOOR = 0.15;
/** How fast the window itself may change, in seconds. */
export const STAB_WINDOW_SMOOTH_S = 0.3;
/** The speed at which the window reaches its full length (0: off). */
export const STAB_SPEED_RAMP_PXS = 0;
/** The most raw samples the ring keeps. */
export const STAB_RING_MAX = 600;
/** The smallest window that is worth averaging over, in seconds. */
export const STAB_MIN_WINDOW_S = 0.002;

/**
 * The length of the window for a place on the strength scale.
 *
 * The scale of the studio runs 0..100; the curve is quadratic, so the bottom
 * of the scale is gentle and the top is firm. Level 0 is no window at all:
 * the raw hand passes through.
 *
 * @param {number} level The place on the 0..100 scale.
 * @param {number} winMaxS The window at the top of the scale, in seconds.
 * @returns {number} The window, in seconds.
 */
export function windowForLevel(level, winMaxS = STAB_WIN_MAX_S) {
  const share = Math.max(0, Math.min(1, Number(level) / 100 || 0));
  return winMaxS * share * share;
}

/** One raw place of the hand: where, when, and how hard. */
function sampleOf(x, y, t, pressure) {
  return { x, y, t, p: pressure };
}

/**
 * The mean of the path over a stretch of time.
 *
 * The path is the straight lines between the samples. Over every stretch of
 * sample line that the window covers, the mean of the two ends is taken for
 * the mean of that part, weighted by how long the window stays on it - the
 * trapezoid rule, which is exact for a path of straight lines. Where the
 * window reaches before the first sample, the first sample holds still.
 *
 * @param {Array<{x:number,y:number,t:number,p:number}>} samples The run, in time order.
 * @param {number} t0 The start of the window, in seconds.
 * @param {number} t1 The end of the window, in seconds.
 * @returns {{x:number,y:number,p:number}|null} The mean, or null when the window holds no time.
 */
export function meanOverWindow(samples, t0, t1) {
  if (!samples || samples.length === 0 || !(t1 > t0)) return null;
  let sumX = 0;
  let sumY = 0;
  let sumP = 0;
  let sumT = 0;
  // The first sample holds for the part of the window before it.
  const first = samples[0];
  if (t0 < first.t) {
    const hold = Math.min(t1, first.t) - t0;
    if (hold > 0) {
      sumX += first.x * hold;
      sumY += first.y * hold;
      sumP += first.p * hold;
      sumT += hold;
    }
  }
  for (let index = 1; index < samples.length; index += 1) {
    const a = samples[index - 1];
    const b = samples[index];
    const span = b.t - a.t;
    if (!(span > 0)) continue;
    const lo = Math.max(a.t, t0);
    const hi = Math.min(b.t, t1);
    if (hi <= lo) continue;
    const ua = (lo - a.t) / span;
    const ub = (hi - a.t) / span;
    const xa = a.x + (b.x - a.x) * ua;
    const ya = a.y + (b.y - a.y) * ua;
    const xb = a.x + (b.x - a.x) * ub;
    const yb = a.y + (b.y - a.y) * ub;
    const weight = hi - lo;
    sumX += ((xa + xb) / 2) * weight;
    sumY += ((ya + yb) / 2) * weight;
    sumP += ((a.p + b.p) / 2) * weight;
    sumT += weight;
  }
  // The last sample holds for the part of the window past it, the way the
  // first holds before it: the hand that has stopped still has a place.
  const last = samples[samples.length - 1];
  if (t1 > last.t) {
    const hold = t1 - Math.max(t0, last.t);
    if (hold > 0) {
      sumX += last.x * hold;
      sumY += last.y * hold;
      sumP += last.p * hold;
      sumT += hold;
    }
  }
  if (!(sumT > 0)) return null;
  return { x: sumX / sumT, y: sumY / sumT, p: sumP / sumT };
}

/**
 * A stroke in the hand: the raw places go in, the calm points come out.
 *
 * The window is counted the way Umoupen counts it: the strength of the
 * stabilizer sets it on a quadratic curve, the speed of the hand may shorten
 * it (the ramp) and the trail may never be longer than a limit, and the
 * window itself eases toward its new length instead of jumping.
 */
export class StabilizerStream {
  /**
   * @param {object} [options]
   * @param {number} [options.level] The place on the 0..100 scale.
   * @param {number} [options.winMaxS] The window at the top of the scale.
   * @param {number} [options.maxLagPx] The furthest the point may trail.
   * @param {number} [options.slowFloor] The share of window kept at rest.
   * @param {number} [options.windowSmoothS] How fast the window may change.
   * @param {number} [options.speedRampPxs] The speed of the full window (0: off).
   */
  constructor(options = {}) {
    this.level = options.level ?? 0;
    this.winMaxS = options.winMaxS ?? STAB_WIN_MAX_S;
    this.maxLagPx = options.maxLagPx ?? STAB_MAX_LAG_PX;
    this.slowFloor = options.slowFloor ?? STAB_SLOW_FLOOR;
    this.windowSmoothS = options.windowSmoothS ?? STAB_WINDOW_SMOOTH_S;
    this.speedRampPxs = options.speedRampPxs ?? STAB_SPEED_RAMP_PXS;
    this.samples = [];
    this.window = 0;
    this.lastTime = -1;
    this.lastEmitTime = -1;
    this.speedAvg = 0;
    this.clamped = false;
  }

  /** A raw place of the hand goes into the ring. */
  push(x, y, t, pressure = 1) {
    const time = Number.isFinite(t) ? t : 0;
    const last = this.samples[this.samples.length - 1];
    if (last && time < last.t) return; // time only moves forward
    this.samples.push(sampleOf(x, y, time, Number.isFinite(pressure) ? pressure : 1));
    if (this.samples.length > STAB_RING_MAX) this.samples.shift();
  }

  /** How fast the hand is moving, from the last two samples, in px/s. */
  currentSpeed() {
    const { samples } = this;
    if (samples.length < 2) return 0;
    const a = samples[samples.length - 2];
    const b = samples[samples.length - 1];
    const dt = b.t - a.t;
    if (!(dt > 0)) return 0;
    return Math.hypot(b.x - a.x, b.y - a.y) / dt;
  }

  /**
   * The length of the window at `now`, in seconds.
   *
   * The target comes from the strength of the stabilizer; the speed of the
   * hand shortens it when the ramp is on; the trail is capped so the drawn
   * point never falls further behind than the lag limit allows; and the
   * window eases toward the target instead of jumping, so the calm of the
   * line does not change in a step while the hand moves.
   */
  windowAt(now) {
    const target0 = windowForLevel(this.level, this.winMaxS);
    let target = target0;
    const dt = this.lastTime >= 0 ? Math.max(0, now - this.lastTime) : 0;
    const speed = this.currentSpeed();
    if (this.lastTime >= 0 && dt > 0) {
      // The speed of the hand is itself eased, over about 80 ms.
      const ease = 1 - Math.exp(-dt / 0.08);
      this.speedAvg += ease * (speed - this.speedAvg);
    } else if (this.lastTime < 0) {
      this.speedAvg = this.speedRampPxs > 0 ? Math.max(this.speedRampPxs, speed) : speed;
    }
    if (this.speedRampPxs > 0 && target > 0) {
      const share = Math.max(0, Math.min(1, this.speedAvg / this.speedRampPxs));
      target *= (1 - this.slowFloor) * share + this.slowFloor;
    }
    if (this.maxLagPx > 0 && this.speedAvg > 1 && target > 0) {
      const cap = (2 * this.maxLagPx) / this.speedAvg;
      if (cap < target) {
        target = cap;
        this.clamped = true;
      }
    }
    if (!(target > 0)) {
      this.window = 0;
      return 0;
    }
    if (this.lastTime < 0) {
      // The first sample takes the target whole.
      this.window = target;
      return this.window;
    }
    // The window eases toward the target, and then may only move so far.
    const smooth = this.windowSmoothS > 0 ? 1 - Math.exp(-dt / this.windowSmoothS) : 1;
    this.window += (target - this.window) * smooth;
    const rate = 1;
    const low = this.window - 3 * dt;
    const high = this.window + rate * dt;
    this.window = Math.max(low, Math.min(high, this.window));
    return this.window;
  }

  /**
   * The calm point for `now`, or null when there is nothing new to say.
   *
   * With no window the raw hand passes through, the way the bottom of the
   * scale promises.
   */
  update(now) {
    const { samples } = this;
    if (samples.length === 0) return null;
    const newest = samples[samples.length - 1];
    const window = this.windowAt(now);
    this.lastTime = now;
    this.lastEmitTime = now;
    if (!(window > STAB_MIN_WINDOW_S)) {
      return { x: newest.x, y: newest.y, p: newest.p };
    }
    // The window never reaches past the newest sample: the mean is taken
    // over the part of the window the hand has already drawn.
    const end = Math.min(now, newest.t);
    const mean = meanOverWindow(samples, end - window, end);
    if (!mean) return { x: newest.x, y: newest.y, p: newest.p };
    return { x: mean.x, y: mean.y, p: mean.p };
  }

  /**
   * The points the window was still holding when the hand lifted.
   *
   * The calm point is the mean of a window of the path, and the mean of a
   * window that ends at the lift sits half a window back along it. So the
   * clock is let run on past the lift with the lift point held still, and
   * the mean is taken again and again as the window drains: the tail swings
   * smoothly round to the place of the lift, with no jump and no shortcut
   * across the corner, and ends exactly where the hand ended.
   *
   * @returns {Array<number[]>} The points, each `[x, y, pressure]`.
   */
  flush() {
    const { samples } = this;
    const out = [];
    if (samples.length === 0) return out;
    const newest = samples[samples.length - 1];
    if (!(this.window > STAB_MIN_WINDOW_S) || samples.length < 2) {
      out.push([newest.x, newest.y, newest.p]);
      return out;
    }
    const start = Math.max(
      this.lastEmitTime >= 0 ? this.lastEmitTime : newest.t - this.window,
      newest.t - this.window,
    );
    const end = newest.t + this.window;
    const step = 1 / 120;
    let last = null;
    for (let t = start + step; t <= end + 1e-9; t += step) {
      const mean = meanOverWindow(samples, t - this.window, t);
      if (!mean) continue;
      const point = [mean.x, mean.y, mean.p];
      if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.35) continue;
      out.push(point);
      last = point;
    }
    // The place of the lift itself, so the stroke ends where the hand ended.
    out.push([newest.x, newest.y, newest.p]);
    return out;
  }
}
