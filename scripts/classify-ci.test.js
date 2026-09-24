import test from "node:test";
import assert from "node:assert/strict";
import { classifyFiles } from "./classify-ci.mjs";

function assertNoHeavy(result) {
  for (const key of [
    "runWeb",
    "runStorage",
    "runLlm",
    "runMac",
    "runRelease",
    "runUi",
    "runLive",
    "runRestic",
    "runAudit"
  ]) {
    assert.equal(result[key], false, key);
  }
}

test("documentation-only changes do not run application checks", () => {
  const result = classifyFiles(["README.md", "docs/VALIDATION.md"]);
  assertNoHeavy(result);
  assert.equal(result.reason, "docs-only");
});

test("workflow metadata changes only run the classifier", () => {
  const result = classifyFiles([".github/workflows/check.yml", "scripts/classify-ci.mjs"]);
  assertNoHeavy(result);
  assert.equal(result.reason, "meta-only");
});

test("frontend component changes run unit/build and UI checks", () => {
  const result = classifyFiles(["src/LayoutEditor.jsx"]);
  assert.equal(result.runWeb, true);
  assert.equal(result.runUi, true);
  assert.equal(result.runRelease, true);
  assert.equal(result.runStorage, false);
  assert.equal(result.runLlm, false);
  assert.equal(result.runMac, false);
  assert.equal(result.runLive, false);
});

test("unrelated frontend logic skips browser and publication integration", () => {
  const result = classifyFiles(["src/lettering.js"]);
  assert.equal(result.runWeb, true);
  assert.equal(result.runUi, false);
  assert.equal(result.runLive, false);
  assert.equal(result.runRelease, true);
});

test("LLM application changes also require native compilation", () => {
  const result = classifyFiles(["src-tauri/src/llm.rs"]);
  assert.equal(result.runLlm, true);
  assert.equal(result.runMac, true);
  assert.equal(result.runRelease, true);
  assert.equal(result.runStorage, false);
  assert.equal(result.runAudit, false);
});

test("storage implementation changes run storage integration and native compilation", () => {
  const result = classifyFiles(["src-tauri/src/storage.rs"]);
  assert.equal(result.runStorage, true);
  assert.equal(result.runRestic, true);
  assert.equal(result.runMac, true);
  assert.equal(result.runRelease, true);
  assert.equal(result.runWeb, true);
});

test("dependency changes use the full safety net and audit", () => {
  const result = classifyFiles(["src-tauri/Cargo.lock"]);
  assert.equal(result.runWeb, true);
  assert.equal(result.runStorage, true);
  assert.equal(result.runLlm, true);
  assert.equal(result.runMac, true);
  assert.equal(result.runRelease, true);
  assert.equal(result.runAudit, true);
});

test("dev-to-main promotion skips duplicate PR validation", () => {
  const result = classifyFiles(["src/LayoutEditor.jsx"], {
    eventName: "pull_request",
    prBase: "main",
    prHead: "dev"
  });
  assertNoHeavy(result);
  assert.equal(result.reason, "dev-to-main-promotion");
});

test("main-to-dev with real code changes is not skipped", () => {
  const result = classifyFiles(["src/LayoutEditor.jsx"], {
    eventName: "pull_request",
    prBase: "dev",
    prHead: "main"
  });
  assert.equal(result.runWeb, true);
});

test("manual runs deliberately execute the full suite", () => {
  const result = classifyFiles([], { eventName: "workflow_dispatch" });
  assert.equal(result.runWeb, true);
  assert.equal(result.runStorage, true);
  assert.equal(result.runLlm, true);
  assert.equal(result.runMac, true);
  assert.equal(result.runRelease, true);
});

test("publication geometry and pinned contracts require actual exporter checks", () => {
  for (const path of ["src/layout.js", "src/render.js", "src/page-art.js", "src/image-crop.js", "vendor/live-manga/contracts/validate.mjs"]) {
    const result=classifyFiles([path]);
    assert.equal(result.runWeb,true,path);
    assert.equal(result.runLive,true,path);
    assert.equal(result.runLlm,false,path);
  }
  assert.equal(classifyFiles(["src-tauri/src/live_export.rs"]).runStorage,true);
});

test("story-source contract changes run the web contract checks only", () => {
  const result = classifyFiles(["contracts/story-source/validate.mjs", "contracts/story-source/manifest.schema.json"]);
  assert.equal(result.runWeb, true);
  assert.equal(result.runStorage, false);
  assert.equal(result.runLlm, false);
  assert.equal(result.runMac, false);
  assert.equal(result.runUi, false);
});

test('name contract changes exercise shared native/web and renderer validation',()=>{const r=classifyFiles(['contracts/name-plan/schema.json']);assert.equal(r.runWeb,true);assert.equal(r.runStorage,true);assert.equal(r.runUi,true);assert.equal(r.runLive,true);assert.equal(r.runMac,true);});
