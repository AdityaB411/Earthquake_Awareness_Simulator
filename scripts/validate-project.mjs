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

const createRoomStart = source.indexOf("async function createRoom()");
const createRoomEnd = source.indexOf("function createShelterZoneForObject", createRoomStart);
if (createRoomStart < 0 || createRoomEnd < 0) {
  failures.push("Could not locate the room-building function for regression checks.");
} else {
  const createRoomSource = source.slice(createRoomStart, createRoomEnd);
  if (createRoomSource.includes("monitorAssembly")) {
    failures.push("createRoom must not reference the fallback-only monitorAssembly variable.");
  }
}
if (source.includes("loadedModels.mouse")) {
  failures.push("main.js references a mouse model key that is not configured in REALISTIC_MODELS.");
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
