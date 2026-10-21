// Find a piece of text in a big file and show it with its surroundings.
import fs from "node:fs";

const [file, needle, before = "400", after = "1200"] = process.argv;
const text = fs.readFileSync(file, "utf8");
let at = 0;
let count = 0;
while (count < 6) {
  const found = text.indexOf(needle, at);
  if (found < 0) break;
  count += 1;
  const from = Math.max(0, found - Number(before));
  console.log(`\n===== ${needle} #${count} at ${found} =====`);
  console.log(text.slice(from, found + Number(after)).replace(/\s+/g, " "));
  at = found + needle.length;
}
if (count === 0) console.log(`"${needle}" was not found`);
