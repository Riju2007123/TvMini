// Try the exports with a smaller picture, the way the resize field of the
// export panel does.
const [, , source] = process.argv;

const post = async (route, body) => {
  const response = await fetch(`http://127.0.0.1:4123${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    console.log(`FAIL ${route} -> ${response.status}: ${text.slice(0, 200)}`);
    return null;
  }
  return JSON.parse(text);
};

const imported = await post("/api/import-clip", { path: source });
if (!imported) process.exit(1);
const project = imported.project;
const out = `${process.env.TEMP}\\tvmini-test\\exports`;

for (const scale of [100, 50, 25]) {
  const data = await post("/api/export-file", {
    path: `${out}\\gif-${scale}`,
    project,
    kind: "gif",
    options: { range: "current", pattern: "{name}_{frame:4}", format: "png", columns: 0, scale },
  });
  console.log(`scale ${scale}%: ${data ? data.summary : "failed"}`);
}
