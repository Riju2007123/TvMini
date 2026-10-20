import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cameraAt,
  cameraKeyAt,
  cameraView,
  contentEnd,
  deleteCameraKey,
  setCameraKey,
} from "../public/timeline.js";
import { createProject, normalizeProject, ValidationError } from "../public/core/model.js";
import { renderProject } from "../public/core/png.js";

function projectWithCamera(keys) {
  return normalizeProject({
    ...createProject(960, 600),
    camera: { keys },
  });
}

test("the camera travels from one key to the next", () => {
  const camera = projectWithCamera([
    { frame: 1, x: 0, y: 0, width: 960, height: 600 },
    { frame: 10, x: 100, y: 50, width: 480, height: 300 },
  ]).camera;

  // Halfway between the two keys the window is half way too.
  const middle = cameraAt(camera, 5.5);
  assert.equal(middle.width, 720);
  assert.equal(middle.x, 50);
  assert.equal(middle.height, 450);
  assert.equal(middle.y, 25);

  // On the first and the last key the camera is exactly there.
  assert.equal(cameraAt(camera, 1).width, 960);
  assert.equal(cameraAt(camera, 10).width, 480);

  // Before the first key and after the last one the camera stays put.
  assert.equal(cameraAt(camera, 0).width, 960);
  assert.equal(cameraAt(camera, 99).width, 480);
});

test("the camera eases or holds when the key says so", () => {
  const linear = projectWithCamera([
    { frame: 1, x: 0, y: 0, width: 10, height: 10, interp: "linear" },
    { frame: 11, x: 0, y: 0, width: 110, height: 110, interp: "linear" },
  ]).camera;
  assert.equal(cameraAt(linear, 6).width, 60);

  const ease = projectWithCamera([
    { frame: 1, x: 0, y: 0, width: 10, height: 10, interp: "ease" },
    { frame: 11, x: 0, y: 0, width: 110, height: 110, interp: "ease" },
  ]).camera;
  // The smoothstep is at its middle: half of the way, but slower at the ends.
  assert.equal(cameraAt(ease, 6).width, 60);
  assert.ok(cameraAt(ease, 3).width < 30);
  assert.ok(cameraAt(ease, 9).width > 90);

  const hold = projectWithCamera([
    { frame: 1, x: 0, y: 0, width: 10, height: 10, interp: "hold" },
    { frame: 11, x: 0, y: 0, width: 110, height: 110, interp: "hold" },
  ]).camera;
  assert.equal(cameraAt(hold, 6).width, 10);
  assert.equal(cameraAt(hold, 11).width, 110);
});

test("the camera turns the short way round", () => {
  const camera = projectWithCamera([
    { frame: 1, x: 0, y: 0, width: 100, height: 100, rotation: 350 },
    { frame: 11, x: 0, y: 0, width: 100, height: 100, rotation: 10 },
  ]).camera;

  // Halfway, the camera is turned 10 degrees over the top, not 180.
  const middle = cameraAt(camera, 6);
  assert.ok(Math.abs(middle.rotation - 360) < 0.001, `rotation was ${middle.rotation}`);
});

test("a camera with no keys shows the whole canvas", () => {
  assert.equal(cameraAt(null, 1), null);
  assert.equal(cameraAt({ keys: [] }, 1), null);
  assert.equal(cameraView(null, 1, 960, 600), null);
});

test("camera keys can be set, replaced and removed", () => {
  let camera = { keys: [] };
  camera = setCameraKey(camera, { frame: 10, x: 0, y: 0, width: 100, height: 100 });
  camera = setCameraKey(camera, { frame: 5, x: 0, y: 0, width: 200, height: 200 });
  assert.deepEqual(camera.keys.map((key) => key.frame), [5, 10]);

  // Setting a key on a frame that already has one replaces it.
  camera = setCameraKey(camera, { frame: 5, x: 9, y: 9, width: 300, height: 300 });
  assert.equal(camera.keys.length, 2);
  assert.equal(cameraKeyAt(camera, 5).width, 300);

  camera = deleteCameraKey(camera, 5);
  assert.deepEqual(camera.keys.map((key) => key.frame), [10]);
});

test("the camera view scales the window to fit and centres it", () => {
  const camera = projectWithCamera([{ frame: 1, x: 100, y: 50, width: 480, height: 300 }]).camera;
  const view = cameraView(camera, 1, 960, 600);

  // 960/480 = 2 and 600/300 = 2, so the window fills the canvas exactly.
  assert.equal(view.scale, 2);
  assert.equal(view.offsetX, 0);
  assert.equal(view.offsetY, 0);

  // A window with a different shape leaves a letterbox.
  const narrow = projectWithCamera([{ frame: 1, x: 0, y: 0, width: 400, height: 300 }]).camera;
  const narrowView = cameraView(narrow, 1, 960, 600);
  assert.equal(narrowView.scale, 2);
  assert.equal(narrowView.offsetX, 80);
});

test("a camera key counts as content for the timeline length", () => {
  const project = projectWithCamera([{ frame: 1, x: 0, y: 0, width: 960, height: 600 }]);
  assert.equal(contentEnd(project), 1);

  const withKey = projectWithCamera([
    { frame: 1, x: 0, y: 0, width: 960, height: 600 },
    { frame: 24, x: 0, y: 0, width: 960, height: 600 },
  ]);
  assert.equal(contentEnd(withKey), 24);
});

test("normalizeProject accepts a camera track and rejects broken ones", () => {
  const project = projectWithCamera([{ frame: 3, x: 10, y: 20, width: 320, height: 240 }]);
  assert.equal(project.camera.keys.length, 1);
  assert.equal(project.camera.keys[0].frame, 3);
  // Every key gets the full set of fields, with safe defaults.
  assert.equal(project.camera.keys[0].rotation, 0);
  assert.equal(project.camera.keys[0].interp, "linear");

  const withCamera = (camera) =>
    normalizeProject({ ...createProject(960, 600), camera });

  assert.throws(() => withCamera({ keys: "nope" }), ValidationError);
  assert.throws(
    () => withCamera({ keys: [{ frame: 1 }, { frame: 1 }] }),
    ValidationError,
  );
  assert.throws(() => withCamera({ keys: [{ frame: 1, width: 0 }] }), ValidationError);
  assert.throws(() => withCamera({ keys: [{ frame: 1, x: "left" }] }), ValidationError);
  assert.throws(() => withCamera({ keys: [{ frame: 1.5 }] }), ValidationError);
  assert.throws(() => withCamera({ keys: [{ frame: 1, interp: "bounce" }] }), ValidationError);
  assert.throws(() => withCamera({ keys: [{ frame: 1, rotation: "left" }] }), ValidationError);

  // Keys are sorted by frame.
  const sorted = withCamera({
    keys: [
      { frame: 8, x: 0, y: 0, width: 100, height: 100 },
      { frame: 2, x: 0, y: 0, width: 100, height: 100 },
    ],
  });
  assert.deepEqual(sorted.camera.keys.map((key) => key.frame), [2, 8]);
});

test("normalizeProject accepts a sound track and rejects broken ones", () => {
  const project = normalizeProject({
    ...createProject(960, 600),
    audio: { name: "beep.wav", data: "UklGRg==", duration: 0.5, offset: 0 },
  });
  assert.equal(project.audio.name, "beep.wav");
  assert.equal(project.audio.duration, 0.5);

  const withAudio = (audio) => normalizeProject({ ...createProject(960, 600), audio });
  assert.throws(() => withAudio({ name: "x.wav" }), ValidationError);
  assert.throws(() => withAudio({ name: "x.wav", data: "" }), ValidationError);
  assert.throws(() => withAudio({ data: "UklGRg==" }), ValidationError);
  assert.throws(
    () => withAudio({ name: "x.wav", data: "UklGRg==", duration: -1 }),
    ValidationError,
  );
  assert.throws(
    () => withAudio({ name: "x.wav", data: "UklGRg==", duration: 0, offset: -100000 }),
    ValidationError,
  );
});

test("a project without a camera or sound still opens", () => {
  const project = normalizeProject(createProject(320, 240));
  assert.equal(project.camera, null);
  assert.equal(project.audio, null);
});

test("the PNG export is cropped to what the camera sees", () => {  const project = normalizeProject({
    ...createProject(960, 600),
    background: "#ffffff",
    camera: { keys: [{ frame: 1, x: 0, y: 0, width: 480, height: 300 }] },
    layers: [
      {
        name: "L",
        type: "anim",
        visible: true,
        locked: false,
        opacity: 1,
        blend: "normal",
        preBehavior: "none",
        postBehavior: "hold",
        drawings: [
          {
            at: 1,
            hold: 1,
            strokes: [{ color: "#ff0000", width: 40, points: [[100, 100]] }],
          },
        ],
      },
    ],
  });

  const framed = renderProject(project, 1);
  assert.equal(framed.width, 480);
  assert.equal(framed.height, 300);

  // The red dot sits at (100, 100) in the canvas, so it is at the same place
  // in the cropped frame.
  const index = (100 * framed.width + 100) * 3;
  assert.deepEqual([...framed.data.slice(index, index + 3)], [255, 0, 0]);

  // A dot outside the camera window is not in the export.
  const outside = renderProject(
    normalizeProject({
      ...project,
      camera: { keys: [{ frame: 1, x: 400, y: 300, width: 200, height: 200 }] },
    }),
    1,
  );
  assert.equal(outside.width, 200);
  const corner = (0 * outside.width + 0) * 3;
  assert.deepEqual([...outside.data.slice(corner, corner + 3)], [255, 255, 255]);
});

test("the export uses the camera as it is on that frame", () => {
  const base = {
    ...createProject(960, 600),
    background: "#ffffff",
    layers: [
      {
        name: "L",
        type: "anim",
        visible: true,
        locked: false,
        opacity: 1,
        blend: "normal",
        preBehavior: "none",
        postBehavior: "hold",
        drawings: [
          {
            at: 1,
            hold: 1,
            strokes: [{ color: "#ff0000", width: 40, points: [[480, 300]] }],
          },
        ],
      },
    ],
  };

  // Two keys: the whole canvas, then a small window on the right.
  const project = normalizeProject({
    ...base,
    camera: {
      keys: [
        { frame: 1, x: 0, y: 0, width: 960, height: 600 },
        { frame: 11, x: 400, y: 200, width: 200, height: 200 },
      ],
    },
  });

  // On frame 1 the camera is wide, so the export is wide.
  assert.equal(renderProject(project, 1).width, 960);
  // On frame 11 it is the small window.
  assert.equal(renderProject(project, 11).width, 200);
  // Halfway the camera is half way too.
  const middle = renderProject(project, 6);
  assert.equal(middle.width, 580);
});

test("the export turns with the camera", () => {
  const project = normalizeProject({
    ...createProject(400, 400),
    background: "#ffffff",
    camera: {
      keys: [{ frame: 1, x: 0, y: 0, width: 400, height: 400, rotation: 90 }],
    },
    layers: [
      {
        name: "L",
        type: "anim",
        visible: true,
        locked: false,
        opacity: 1,
        blend: "normal",
        preBehavior: "none",
        postBehavior: "hold",
        drawings: [
          {
            at: 1,
            hold: 1,
            strokes: [{ color: "#ff0000", width: 30, points: [[20, 200]] }],
          },
        ],
      },
    ],
  });

  const turned = renderProject(project, 1);
  assert.equal(turned.width, 400);
  assert.equal(turned.height, 400);

  // The red dot was on the left edge; turned by 90 degrees it is on the top.
  const top = (20 * turned.width + 200) * 3;
  assert.deepEqual([...turned.data.slice(top, top + 3)], [255, 0, 0]);
  const left = (200 * turned.width + 20) * 3;
  assert.deepEqual([...turned.data.slice(left, left + 3)], [255, 255, 255]);
});
