import test from "node:test";
import assert from "node:assert/strict";
import {
  WHEEL_SIZE,
  hsvToRgb,
  hueAtPoint,
  huePoint,
  rgbToHsv,
  svAtPoint,
  wheelLayout,
  wheelPick,
} from "../public/core/wheel.js";

const layout = wheelLayout();

/** A point of the ring, a little outside the middle of the ring. */
function ringPoint(hue) {
  const point = huePoint(hue, layout);
  const dx = point.x - layout.centre;
  const dy = point.y - layout.centre;
  const radius = Math.hypot(dx, dy);
  const scale = (layout.ringMiddle + layout.ringInner) / 2 / radius;
  return { x: layout.centre + dx * scale, y: layout.centre + dy * scale };
}

test("the wheel is a ring with a square inside it", () => {
  assert.equal(layout.size, WHEEL_SIZE);
  assert.equal(layout.centre, WHEEL_SIZE / 2);
  // The square is inscribed in the ring: its corner reaches the inner edge.
  const corner = Math.hypot(layout.svHalf, layout.svHalf);
  assert.ok(corner <= layout.ringInner, "the square stays inside the ring");
  assert.ok(corner > layout.ringInner - 2, "the square reaches the ring");
});

test("the hue of an arc is read at the angle the arc is drawn at", () => {
  for (const hue of [0, 15, 90, 180, 225, 270, 359]) {
    const point = huePoint(hue, layout);
    const read = hueAtPoint(point.x, point.y, layout);
    assert.ok(Math.abs(read - hue) < 0.001, `${hue} came back as ${read}`);
  }
});

test("clicking the ring picks the colour of the arc under the cursor", () => {
  // The ring is drawn with the arc of a hue at the angle of that hue, so the
  // pick has to read the hue at that same angle. When it does not, the
  // marker of the ring lands a quarter turn away from the arc that was
  // clicked, and the colour that comes out is not the colour of that arc.
  for (const hue of [0, 30, 90, 150, 180, 210, 270, 330]) {
    const point = ringPoint(hue);
    const pick = wheelPick(point.x, point.y, layout);
    assert.equal(pick.region, "ring");
    assert.ok(Math.abs(pick.hue - hue) < 0.5, `${hue} came back as ${pick.hue}`);
  }
});

test("the marker of the ring lands on the arc that was clicked", () => {
  for (const hue of [0, 90, 180, 270]) {
    const point = ringPoint(hue);
    const pick = wheelPick(point.x, point.y, layout);
    const marker = huePoint(pick.hue, layout);
    // The marker sits on the middle of the ring, so only the angle is
    // compared: the marker has to be on the arc that was clicked.
    const clicked = hueAtPoint(point.x, point.y, layout);
    const marked = hueAtPoint(marker.x, marker.y, layout);
    assert.ok(Math.abs(marked - clicked) < 0.5, "the marker follows the cursor");
  }
});

test("the arc of a hue is the colour of that hue", () => {
  // The arc at 3 o'clock is red, and the pick there is red.
  const right = ringPoint(0);
  const pick = wheelPick(right.x, right.y, layout);
  assert.deepEqual(hsvToRgb(pick.hue, 1, 1), [255, 0, 0]);
  // The arc at the bottom is green.
  const bottom = ringPoint(120);
  assert.deepEqual(hsvToRgb(wheelPick(bottom.x, bottom.y, layout).hue, 1, 1), [0, 255, 0]);
});

test("clicking the square reads the saturation and the value", () => {
  // White in the top left corner, black in the bottom right one.
  const topLeft = wheelPick(layout.squareX, layout.squareY, layout);
  assert.equal(topLeft.region, "square");
  assert.equal(topLeft.saturation, 0);
  assert.equal(topLeft.value, 1);

  const bottomRight = wheelPick(layout.squareX + layout.side, layout.squareY + layout.side, layout);
  assert.equal(bottomRight.saturation, 1);
  assert.equal(bottomRight.value, 0);

  const middle = wheelPick(layout.centre, layout.centre, layout);
  assert.equal(middle.saturation, 0.5);
  assert.equal(middle.value, 0.5);
});

test("the square is asked before the ring, so its corner is not the ring", () => {
  // The corner of the square reaches the inner edge of the ring: a click
  // there is a click in the square, not a change of the hue.
  const corner = wheelPick(layout.squareX, layout.squareY, layout);
  assert.equal(corner.region, "square");
  assert.equal(corner.value, 1);
});

test("a point outside the wheel holds nothing", () => {
  const pick = wheelPick(layout.centre, layout.centre - layout.ringOuter - 10, layout);
  assert.equal(pick.region, "none");
});

test("the saturation and the value of a point are where they are drawn", () => {
  // The square runs from white on the left to the pure hue on the right, and
  // from the pure hue at the top to black at the bottom.
  const left = svAtPoint(layout.squareX, layout.centre, layout);
  assert.equal(left.saturation, 0);
  const right = svAtPoint(layout.squareX + layout.side, layout.centre, layout);
  assert.equal(right.saturation, 1);
  const top = svAtPoint(layout.centre, layout.squareY, layout);
  assert.equal(top.value, 1);
  const bottom = svAtPoint(layout.centre, layout.squareY + layout.side, layout);
  assert.equal(bottom.value, 0);
});

test("a colour comes back from its own hue, saturation and value", () => {
  for (const [hue, saturation, value] of [
    [0, 1, 1],
    [120, 1, 1],
    [240, 1, 1],
    [302, 0.1, 1],
    [215, 0.436, 0.216],
  ]) {
    const [r, g, b] = hsvToRgb(hue, saturation, value);
    const [backHue, backSaturation, backValue] = rgbToHsv(r, g, b);
    assert.ok(Math.abs(backHue - hue) < 1.5, `${hue} came back as ${backHue}`);
    assert.ok(Math.abs(backSaturation - saturation) < 0.01);
    assert.ok(Math.abs(backValue - value) < 0.01);
  }
});

test("a grey has no hue of its own", () => {
  const [hue, saturation, value] = rgbToHsv(128, 128, 128);
  assert.equal(saturation, 0);
  assert.equal(value, 128 / 255);
  assert.equal(hue, 0); // the caller is the one that keeps the hue it had
});
