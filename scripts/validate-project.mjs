import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const sourcePath = resolve(root, "main.js");
const htmlPath = resolve(root, "index.html");
const source = readFileSync(sourcePath, "utf8");
const html = readFileSync(htmlPath, "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const failures = [];

for (const scriptName of ["dev", "preview"]) {
  const command = packageJson.scripts?.[scriptName] || "";
  if (/\s--host(?:\s|$)/.test(command)) {
    failures.push(`The ${scriptName} script overrides the local-only Vite host: ${command}`);
  }
}

const htmlIds = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
const idCounts = new Map();
for (const id of htmlIds) idCounts.set(id, (idCounts.get(id) || 0) + 1);

for (const [id, count] of idCounts) {
  if (count > 1) failures.push(`Duplicate HTML id: ${id}`);
}

const referencedIds = new Set(
  [...source.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1])
);
for (const id of referencedIds) {
  if (!idCounts.has(id)) failures.push(`main.js references missing HTML id: ${id}`);
}

const assetFiles = new Set([...source.matchAll(/["']([^"']+\.glb)["']/g)].map((match) => match[1]));
for (const filename of assetFiles) {
  if (filename.includes("/") || filename.includes("\\")) {
    failures.push(`Expected a local GLB filename, received: ${filename}`);
    continue;
  }
  const assetPath = resolve(root, "public", "assets", "3D", filename);
  if (!existsSync(assetPath)) failures.push(`Missing GLB asset referenced by main.js: public/assets/3D/${filename}`);
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Project validation passed: ${htmlIds.length} HTML ids, ${referencedIds.size} static UI references, ${assetFiles.size} GLB filenames.`);
}
