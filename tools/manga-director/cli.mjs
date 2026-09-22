#!/usr/bin/env node
import { readFile, lstat, realpath, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runDirector } from './loop.mjs';
import { DirectorError, check, copy, sha256, prepareInput } from './data.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const HELP = `Manga Director (Node 22+, no Tauri / manga-mac process)
  node tools/manga-director/cli.mjs --input INPUT.json --adapter HOST.mjs --out NEW_DIRECTORY
  [--root SOURCE_DIRECTORY] [--max-iterations 3] [--max-model-calls 6]
  [--timeout-ms 120000] [--max-added-cp 2000] [--max-added-pages 2]

INPUT: {snapshot:{id,workId,scenes:[{id,text OR path}],...},selectedSceneIds?,context?}
Scene paths are relative to --root (default: INPUT's directory); no symlinks.
--adapter is explicitly trusted executable host code, NEVER a model-supplied file.
The output directory must not already exist. Canonical input files are never written.
A host uses the shared #253 validator and #255 planner; there is no fake fallback.
--allow-fixture permits test doubles and labels all results as fixture (not live AI).
Exit 0: candidate review available. Exit 2: stopped with unresolved work/failure.
No result is automatically approved or committed; no automatic restart/retry.
`;

function relativeSource(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 400 &&
    !path.isAbsolute(value) && !/[\\\x00-\x1f]/u.test(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes(':')), 'UNSAFE_SOURCE_PATH');
  return value;
}
async function readRegular(file) {
  const stat = await lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BYTES, 'UNSAFE_INPUT_FILE');
  const handle = await open(file, 'r');
  try {
    const now = await handle.stat();
    check(now.ino === stat.ino && now.dev === stat.dev && now.size <= MAX_BYTES, 'INPUT_FILE_CHANGED');
    const buffer = await handle.readFile();
    check(buffer.byteLength <= MAX_BYTES, 'PAYLOAD_LIMIT');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } finally { await handle.close(); }
}
async function withinRoot(root, relative) {
  const parts = relativeSource(relative).split('/');
  let file = root;
  for (const part of parts) {
    file = path.join(file, part);
    check(!(await lstat(file)).isSymbolicLink(), 'SOURCE_SYMLINK');
  }
  check((await realpath(file)) === file, 'SOURCE_SYMLINK');
  return file;
}
async function writeNew(directory, filename, value) {
  const handle = await open(path.join(directory, filename), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, strict: true, options: {
    input: { type: 'string' }, adapter: { type: 'string' }, out: { type: 'string' }, root: { type: 'string' },
    'max-iterations': { type: 'string' }, 'max-model-calls': { type: 'string' },
    'timeout-ms': { type: 'string' }, 'max-added-cp': { type: 'string' }, 'max-added-pages': { type: 'string' },
    'allow-fixture': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) { process.stdout.write(HELP); return 0; }
  check(values.input && values.adapter && values.out, 'REQUIRED_ARGUMENT');
  const inputPath = path.resolve(values.input), requestedOutput = path.resolve(values.out);
  const output = path.join(await realpath(path.dirname(requestedOutput)), path.basename(requestedOutput));
  const root = await realpath(path.resolve(values.root ?? path.dirname(inputPath)));
  const watched = new Map();
  const readWatched = async file => {
    const content = await readRegular(file);
    watched.set(file, sha256(content)); return content;
  };
  const raw = copy(JSON.parse(await readWatched(inputPath)));
  check(raw.snapshot && Array.isArray(raw.snapshot.scenes), 'INVALID_SNAPSHOT');
  // Resolve explicit inputs only; never scan the repo, .env, git config, or assets.
  let total = 0;
  for (const scene of raw.snapshot.scenes) {
    if (scene.path !== undefined) {
      const content = await readWatched(await withinRoot(root, scene.path));
      check(scene.text === undefined || scene.text === content, 'SOURCE_TEXT_MISMATCH');
      scene.text = content;
    }
    total += Buffer.byteLength(scene.text ?? '');
    check(total <= MAX_BYTES, 'PAYLOAD_LIMIT');
  }
  const input = prepareInput(raw);
  const guard = async () => {
    for (const [file, hash] of watched) check(sha256(await readRegular(file)) === hash, 'SOURCE_CHANGED');
  };
  // Only the explicit CLI adapter is executable. Manuscripts cannot choose modules.
  const adapterPath = await realpath(path.resolve(values.adapter));
  check(!watched.has(adapterPath), 'ADAPTER_IS_SOURCE');
  const adapter = (await import(pathToFileURL(adapterPath).href)).default;
  check(adapter?.mode !== 'fixture' || values['allow-fixture'], 'FIXTURE_NOT_ALLOWED');
  const limits = {};
  for (const [flag, key] of Object.entries({
    'max-iterations': 'maxIterations', 'max-model-calls': 'maxModelCalls',
    'timeout-ms': 'stageTimeoutMs', 'max-added-cp': 'maxAddedCp', 'max-added-pages': 'maxAddedPages',
  })) if (values[flag] !== undefined) {
    check(/^\d+$/.test(values[flag]), 'INVALID_LIMIT'); limits[key] = Number(values[flag]);
  }
  // Require an existing, explicitly selected parent. EEXIST never overwrites a run.
  await guard();
  await mkdir(output, { mode: 0o700 });
  const journal = await open(path.join(output, 'events.jsonl'), 'wx', 0o600);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    await writeNew(output, 'input-snapshot.json', input);
    const result = await runDirector(input, adapter, {
      limits, signal: controller.signal, assertSourceUnchanged: guard,
      checkpoint: async event => { await journal.writeFile(JSON.stringify(event) + '\n'); await journal.sync(); },
    });
    await guard();
    await writeNew(output, 'working-manuscript.json', result.workingSnapshot);
    if (result.namePlan !== null) await writeNew(output, 'name-plan.json', result.namePlan);
    await writeNew(output, 'final-diff.json', { originalHash: result.originalHash, workingHash: result.workingHash, changes: result.finalDiff, approval: 'pending' });
    await writeNew(output, 'script-suggestions.json', result.iterations.map(row => ({
      iteration: row.iteration, suggestions: row.review?.suggestions ?? [], decisions: row.decisions,
    })));
    // Completion receipt is written LAST. A directory without it is an incomplete run.
    await writeNew(output, 'result.json', result);
    process.stdout.write(JSON.stringify({ status: result.status, stopReason: result.stopReason,
      iterations: result.iterations.length, mode: result.adapter.mode, output }) + '\n');
    return result.stopReason === 'no_major_issues' ? 0 : 2;
  } catch (error) {
    const code = error instanceof DirectorError ? error.code : 'EXECUTION_FAILED';
    await writeNew(output, 'failure.json', { status: 'blocked', code, autoResume: false });
    throw new DirectorError(code);
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await journal.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    // Never echo raw provider errors, prompts, or credential-bearing URLs.
    process.stderr.write(`Manga Director: ${error instanceof DirectorError ? error.code : 'INVALID_INPUT_OR_IO'}\n`);
    process.exitCode = 2;
  });
}
