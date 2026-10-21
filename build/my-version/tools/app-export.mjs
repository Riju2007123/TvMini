// Do what the application does: import a .clip, then export it again.
const [, , file, out] = process.argv;

const post = async (route, body) => {
  const response = await fetch(`http://127.0.0.1:4123${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} -> ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

const imported = await post("/api/import-clip", { path: file });
console.log(`imported ${imported.name}: ${imported.project.layers.length} layers, camera ${imported.project.camera ? "yes" : "no"}`);

const started = Date.now();
const exported = await post("/api/export-clip", {
  path: out,
  project: imported.project,
  sourcePath: file,
});
console.log(`exported in ${Date.now() - started} ms:`, JSON.stringify(exported));
