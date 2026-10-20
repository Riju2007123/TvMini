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

test("the camera holds its last key until the next one", () => {
  const camera = projectWithCamera([
    { frame: 1, x: 0, y: 0, width: 960, height: 600 },
    { frame: 10, x: 100, y: 50, width: 480, height: 300 },
  ]).camera;

  assert.equal(cameraAt(camera, 1).width, 960);
  assert.equal(cameraAt(camera, 9).width, 960);
  assert.equal(cameraAt(camera, 10).width, 480);
  assert.equal(cameraAt(camera, 99).width, 480);
  assert.equal(cameraAt(camera, 99).x, 100);
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

test("the PNG export is cropped to what the camera sees", () => {
  const project = normalizeProject({
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
