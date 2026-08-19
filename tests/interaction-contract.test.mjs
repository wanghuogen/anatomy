import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
const componentFiles = ["app/components/AnatomyApp.tsx", "app/components/OrganViewer.tsx", "app/components/ClinicalEducation.tsx"];

function buttonContracts(source, fileName) {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const failures = [];
  function visit(node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(tree) === "button") {
      const names = new Set(node.attributes.properties.filter(ts.isJsxAttribute).map((attribute) => attribute.name.getText(tree)));
      if (!names.has("onClick") && !names.has("disabled")) {
        const location = tree.getLineAndCharacterOfPosition(node.getStart(tree));
        failures.push(`${fileName}:${location.line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return failures;
}

test("every rendered button has an action or is explicitly disabled", async () => {
  const failures = [];
  for (const relative of componentFiles) {
    const source = await readFile(path.join(root, relative), "utf8");
    failures.push(...buttonContracts(source, relative));
  }
  assert.deepEqual(failures, [], `buttons without a contract: ${failures.join(", ")}`);
});

test("every 3D toolbar item has a handler branch", async () => {
  const source = await readFile(path.join(root, "app", "components", "OrganViewer.tsx"), "utf8");
  const toolBlock = source.slice(source.indexOf("const tools = ["), source.indexOf("].filter", source.indexOf("const tools = [")));
  const ids = [...toolBlock.matchAll(/id: "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(ids.length >= 6);
  for (const id of ids) assert.match(source, new RegExp(`tool === "${id}"`), `toolbar action ${id} has no handler`);
});

test("reset restores all persistent viewer modes", async () => {
  const source = await readFile(path.join(root, "app", "lib", "three", "viewer.ts"), "utf8");
  const reset = source.slice(source.indexOf("reset()"), source.indexOf("zoom(direction", source.indexOf("reset()")));
  assert.match(reset, /this\.zoomed = false/);
  assert.match(reset, /this\.isolated = false/);
  assert.match(reset, /this\.crossSection = false/);
  assert.match(reset, /this\.applyClipping\(false\)/);
  assert.match(reset, /material\.wireframe = false/);
});

test("heart internal mode remains a separate model instead of replacing the exterior", async () => {
  const source = await readFile(path.join(root, "app", "lib", "anatomy-data.ts"), "utf8");
  assert.match(source, /model: "\/models\/heart\.glb"/);
  assert.match(source, /internalView:\s*\{/);
  assert.match(source, /model: "\/models\/heart-internal-hra-v1\.3\.glb"/);
});

test("clinical education covers the perioperative communication loop", async () => {
  const source = await readFile(path.join(root, "app", "components", "ClinicalEducation.tsx"), "utf8");
  for (const state of ["normal", "disease", "postop"]) assert.match(source, new RegExp(`id: "${state}"`));
  assert.match(source, /二尖瓣修复术/);
  assert.match(source, /术前路径/);
  assert.match(source, /恢复清单/);
  assert.match(source, /理解确认/);
  assert.match(source, /不保存患者身份或病历信息/);
  assert.match(source, /不替代医生诊断、个体化治疗建议或正式知情同意/);
  assert.match(source, /aria-pressed=\{checked\.has\(index\)\}/);
  assert.match(source, /setAnswers/);
});

test("clinical animation deforms the real HRA mitral valve and renders directional 3D flow", async () => {
  const component = await readFile(path.join(root, "app", "components", "ClinicalEducation.tsx"), "utf8");
  const viewer = await readFile(path.join(root, "app", "lib", "three", "viewer.ts"), "utf8");

  assert.match(component, /function ClinicalHeart3D/);
  assert.match(component, /const internal = heart\.internalView/);
  assert.match(component, /viewer\.setOrgan\(internal\.model/);
  assert.match(component, /setClinicalHeartAnimation\(state, playing, phase\)/);
  for (const mesh of ["VH_M_mitral_valve", "VH_M_left_cardiac_atrium", "VH_M_heart_left_ventricle"]) {
    assert.match(viewer, new RegExp(mesh), `missing HRA mesh binding: ${mesh}`);
  }
  assert.match(viewer, /animatedGeometry/);
  assert.match(viewer, /clinical-mitral-forward-flow/);
  assert.match(viewer, /clinical-mitral-reflux/);
  assert.match(viewer, /depthTest: false/);
});
