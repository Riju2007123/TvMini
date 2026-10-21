// Try every export the application offers, the way the application does.
const [, , source] = process.argv;

const post = async (route, body) => {
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:4123${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const ms = Date.now() - started;
  if (!response.ok) {
    console.log(`FAIL ${route} -> ${response.status}: ${text.slice(0, 200)}`);
    return null;
  }
  const data = JSON.parse(text);
  console.log(`OK   ${route} (${ms} ms): ${JSON.stringify(data).slice(0, 200)}`);
  return data;
};

const imported = await post("/api/import-clip", { path: source });
if (!imported) process.exit(1);
const project = imported.project;
const out = `${process.env.TEMP}\\tvmini-test\\exports`;
await (await import("node:fs/promises")).mkdir(out, { recursive: true });

await post("/api/export", { path: `${out}\\frame.png`, project });
await post("/api/export-clip", { path: `${out}\\whole.clip`, project, sourcePath: source });
await post("/api/export-tvpp", { path: `${out}\\movie.tvpp`, project, sourcePath: source });
for (const kind of ["psd", "gif", "sheet", "sequence", "xdts", "csv"]) {
  await post("/api/export-file", {
    path: `${out}\\${kind}`,
    project,
    kind,
    options: { range: "current", pattern: "{name}_{frame:4}", format: "png", columns: 0 },
  });
}
