import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
const modelsDir = path.join(root, "public", "models");

async function parseGlb(file) {
  const bytes = await readFile(file);
  assert.equal(bytes.toString("ascii", 0, 4), "glTF", `${path.basename(file)} has an invalid GLB magic header`);
  assert.equal(bytes.readUInt32LE(4), 2, `${path.basename(file)} must use glTF 2.0`);
  assert.equal(bytes.readUInt32LE(8), bytes.length, `${path.basename(file)} length header is incorrect`);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.toString("ascii", 16, 20), "JSON", `${path.basename(file)} has no JSON chunk`);
  return JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength).trim());
}

test("every declared GLB exists and has a renderable scene", async () => {
  const anatomySource = await readFile(path.join(root, "app", "lib", "anatomy-data.ts"), "utf8");
  const declared = [...anatomySource.matchAll(/"(\/models\/[^"?]+\.glb)"/g)].map((match) => match[1]);
  assert.ok(declared.length >= 10, "expected the organ models plus the internal heart model");
  for (const url of new Set(declared)) {
    const file = path.join(root, "public", ...url.split("/").filter(Boolean));
    await access(file);
    const gltf = await parseGlb(file);
    assert.ok(gltf.scenes?.length, `${url} has no scene`);
    assert.ok(gltf.nodes?.length, `${url} has no nodes`);
    assert.ok(gltf.meshes?.length, `${url} has no meshes`);
  }
});

test("the internal heart manifest matches exact HRA mesh nodes", async () => {
  const anatomySource = await readFile(path.join(root, "app", "lib", "anatomy-data.ts"), "utf8");
  const declaredNodes = [...anatomySource.matchAll(/nodeName: "([^"]+)"/g)].map((match) => match[1]);
  assert.equal(declaredNodes.length, 14, "the HRA heart should expose 14 renderable structures");
  assert.equal(new Set(declaredNodes).size, declaredNodes.length, "internal structure node names must be unique");

  const gltf = await parseGlb(path.join(modelsDir, "heart-internal-hra-v1.3.glb"));
  const meshNodes = new Set((gltf.nodes ?? []).filter((node) => node.mesh !== undefined).map((node) => node.name));
  for (const node of declaredNodes) assert.ok(meshNodes.has(node), `missing HRA mesh node: ${node}`);

  const crosswalk = await readFile(path.join(modelsDir, "heart-internal-hra-v1.3-crosswalk.csv"), "utf8");
  assert.match(crosswalk, /^node_name,OntologyID,label/m);
  for (const node of declaredNodes) assert.match(crosswalk, new RegExp(`^${node},`, "m"), `${node} is absent from the crosswalk`);
  await access(path.join(modelsDir, "heart-internal-hra-v1.3.LICENSE.md"));
});

test("all bundled GLBs stay within the browser delivery budget", async () => {
  const files = (await readdir(modelsDir)).filter((file) => file.endsWith(".glb"));
  for (const file of files) {
    const bytes = await readFile(path.join(modelsDir, file));
    assert.ok(bytes.length <= 8 * 1024 * 1024, `${file} exceeds the 8 MiB asset budget`);
  }
});
