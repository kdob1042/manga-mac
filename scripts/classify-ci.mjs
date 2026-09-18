import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function emptyResult(reason) {
  return {
    runWeb: false,
    runStorage: false,
    runLlm: false,
    runBlender: false,
    runMac: false,
    runRelease: false,
    runUi: false,
    runLive: false,
    runRestic: false,
    runBlenderRender: false,
    runAudit: false,
    reason
  };
}

function mark(result, component) {
  if (component === "web") result.runWeb = true;
  if (component === "storage") result.runStorage = true;
  if (component === "llm") result.runLlm = true;
  if (component === "blender") result.runBlender = true;
}

function markAll(result) {
  mark(result, "web");
  mark(result, "storage");
  mark(result, "llm");
  mark(result, "blender");
  result.runMac = true;
  result.runRelease = true;
  result.runUi = true;
  result.runLive = true;
  result.runRestic = true;
  result.runBlenderRender = true;
  result.runAudit = true;
}

function normalizeFiles(files) {
  if (Array.isArray(files)) {
    return files.map(file => String(file).trim()).filter(Boolean);
  }
  return String(files ?? "")
    .split(/\r?\n/)
    .map(file => file.trim())
    .filter(Boolean);
}

function isDocumentation(file) {
  return file.startsWith("docs/") || file.toLowerCase().endsWith(".md");
}

function isWorkflowMetadata(file) {
  return file.startsWith(".github/") ||
    file === "scripts/classify-ci.mjs" ||
    file === "scripts/classify-ci.test.js";
}

function isCargoManifest(file) {
  return file.endsWith("Cargo.toml") || file.endsWith("Cargo.lock");
}

export function classifyFiles(files, context = {}) {
  const eventName = context.eventName ?? "pull_request";
  const prBase = context.prBase ?? "";
  const prHead = context.prHead ?? "";
  const paths = normalizeFiles(files);

  if (eventName === "pull_request" && prHead === "dev" && prBase === "main") {
    return emptyResult("dev-to-main-promotion");
  }

  if (eventName === "workflow_dispatch") {
    const result = emptyResult("manual-run");
    markAll(result);
    return result;
  }

  if (paths.length === 0) {
    return emptyResult("no-file-change");
  }

  const result = emptyResult("scoped-change");
  let sawApplicationChange = false;
  let sawDocumentation = false;
  let sawMetadata = false;
  let sawUnknown = false;

  for (const file of paths) {
    if (isDocumentation(file)) {
      sawDocumentation = true;
      continue;
    }

    if (isWorkflowMetadata(file)) {
      sawMetadata = true;
      continue;
    }

    sawApplicationChange = true;
    let matched = true;

    if (file === "package.json" || file === "package-lock.json") {
      mark(result, "web");
      result.runMac = true;
      result.runRelease = true;
      result.runUi = true;
    } else if (file === "index.html") {
      mark(result, "web");
      result.runUi = true;
      result.runRelease = true;
    } else if (file === "playwright.config.js") {
      mark(result, "web");
      result.runUi = true;
    } else if (file.startsWith("src/")) {
      mark(result, "web");
      result.runRelease = true;
      if (file.endsWith(".jsx") || file.endsWith(".css") || file === "src/main.jsx") {
        result.runUi = true;
      }
      if (file === "src/bridge.js") {
        result.runMac = true;
      }
      if (file.includes("live-export") || file.includes("video") || ["src/render.js", "src/page-art.js", "src/layout.js", "src/image-crop.js"].includes(file)) {
        result.runLive = true;
      }
    } else if (file.startsWith("tests/ui/")) {
      mark(result, "web");
      result.runUi = true;
    } else if (file.startsWith("tests/llm/")) {
      mark(result, "llm");
      if (isCargoManifest(file)) result.runAudit = true;
    } else if (file.startsWith("tests/storage/")) {
      mark(result, "storage");
      result.runRestic = true;
    } else if (file.startsWith("tests/blender/")) {
      mark(result, "blender");
    } else if (file.startsWith("tests/")) {
      mark(result, "web");
      if (file === "tests/live-contract.test.js") result.runLive = true;
    } else if (file.startsWith("src-tauri/") && isCargoManifest(file)) {
      markAll(result);
    } else if (file.startsWith("src-tauri/src/")) {
      result.runMac = true;
      result.runRelease = true;

      if (file.endsWith("/main.rs")) {
        markAll(result);
      } else if (/(backup|restic|storage|image_recovery)/.test(file)) {
        mark(result, "storage");
        result.runRestic = true;
        result.runWeb = true;
      } else if (/(^|\/)(llm|llm_tests|policy_transport)\.rs$/.test(file)) {
        mark(result, "llm");
      } else if (file.endsWith("/blender.rs")) {
        mark(result, "blender");
        result.runBlenderRender = true;
      } else if (file.endsWith("/live_export.rs")) {
        mark(result, "storage");
        mark(result, "web");
        result.runLive = true;
      } else if (/(web_asset|draft|layout|lettering|runway)\.rs$/.test(file)) {
        mark(result, "web");
      } else {
        markAll(result);
      }
    } else if (
      file === "src-tauri/build.rs" ||
      file === "src-tauri/tauri.conf.json" ||
      file.startsWith("src-tauri/capabilities/")
    ) {
      result.runMac = true;
      result.runRelease = true;
    } else if (file.startsWith("helper/")) {
      result.runMac = true;
      result.runRelease = true;
    } else if (file.startsWith("assets/")) {
      mark(result, "web");
      result.runMac = true;
      result.runRelease = true;
    } else if (file.startsWith("blender/")) {
      mark(result, "blender");
      result.runBlenderRender = true;
    } else if (file === "scripts/install-backup-tools.sh") {
      mark(result, "storage");
      result.runRestic = true;
    } else if (file === "scripts/audit_osv.py") {
      mark(result, "llm");
      result.runAudit = true;
    } else if (
      file === "scripts/live-e2e.mjs" ||
      file === "scripts/sync-live-contract.mjs"
    ) {
      mark(result, "web");
      result.runLive = true;
    } else if (file.startsWith("vendor/live-manga/")) {
      mark(result, "web");
      mark(result, "storage");
      result.runLive = true;
    } else if (file.startsWith("contracts/story-source/")) {
      mark(result, "web");
    } else if (file.startsWith("scripts/") && file.endsWith(".mjs")) {
      mark(result, "web");
    } else {
      matched = false;
      markAll(result);
    }

    if (!matched) sawUnknown = true;
  }

  if (!sawApplicationChange) {
    if (sawDocumentation && !sawMetadata) return emptyResult("docs-only");
    if (sawMetadata && !sawDocumentation) return emptyResult("meta-only");
    return emptyResult("non-app-only");
  }

  if (sawUnknown) result.reason = "unknown-change";
  return result;
}

export function outputLines(result) {
  return [
    ["run_web", result.runWeb],
    ["run_storage", result.runStorage],
    ["run_llm", result.runLlm],
    ["run_blender", result.runBlender],
    ["run_mac", result.runMac],
    ["run_release", result.runRelease],
    ["run_ui", result.runUi],
    ["run_live", result.runLive],
    ["run_restic", result.runRestic],
    ["run_blender_render", result.runBlenderRender],
    ["run_audit", result.runAudit],
    ["run_heavy", result.runWeb || result.runStorage || result.runLlm || result.runBlender || result.runMac || result.runRelease],
    ["reason", result.reason]
  ].map(pair => pair[0] + "=" + pair[1]).join("\n");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const files = fs.readFileSync(0, "utf8");
  const result = classifyFiles(files, {
    eventName: process.env.CI_EVENT_NAME ?? "pull_request",
    prBase: process.env.CI_PR_BASE ?? "",
    prHead: process.env.CI_PR_HEAD ?? ""
  });
  process.stdout.write(outputLines(result) + "\n");
}
