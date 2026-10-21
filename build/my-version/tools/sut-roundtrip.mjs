/**
 * Write a Clip Studio Paint brush and read it back.
 *
 *   node tools/sut-roundtrip.mjs
 */
import { writeFileSync } from "node:fs";
import { encodeRgbaPng } from "../src/png.js";
import { writeSutBrush } from "../public/core/sut-write.js";
import { readSutBrush } from "../public/core/sut.js";

/** A round, soft picture to use as the tip of the brush. */
function tipPng(size = 64) {
  const data = Buffer.alloc(size * size * 4);
  const middle = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const distance = Math.hypot(x - middle, y - middle) / middle;
      const alpha = Math.max(0, Math.min(1, 1 - distance));
      data[index] = 20;
      data[index + 1] = 20;
      data[index + 2] = 30;
      data[index + 3] = Math.round(alpha * 255);
    }
  }
  return encodeRgbaPng(size, size, data);
}

const png = tipPng();
console.log(`the picture of the tip: ${png.length} bytes`);

const bytes = await writeSutBrush({
  name: "TVMini round brush",
  size: 24,
  opacity: 80,
  flow: 60,
  hardness: 50,
  thickness: 90,
  texture: { data: png.toString("base64") },
});

const file = `${process.env.TEMP ?? "."}\\tvmini-test\\tvmini-brush.sut`;
writeFileSync(file, bytes);
console.log(`the brush file: ${bytes.length} bytes, written to ${file}`);

const brush = await readSutBrush(bytes);
console.log("read back:");
console.log(`  name: ${brush.name}`);
console.log(`  size: ${brush.size}`);
console.log(`  flow: ${brush.flow}, hardness: ${brush.hardness}, thickness: ${brush.thickness}`);
console.log(`  the picture: ${brush.texture.width} by ${brush.texture.height}`);

// A brush with no picture at all is still a brush.
const plain = await writeSutBrush({ name: "plain", size: 6 });
console.log(`a brush with no picture: ${plain.length} bytes`);
