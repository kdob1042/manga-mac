// Verify the packaged DMG, rather than a development binary. Never downloads a model.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const bundle = path.resolve(process.argv[2] ?? 'src-tauri/target/aarch64-apple-darwin/release/bundle');
const provenance = JSON.parse(await readFile('mac-acceptance-kit/build-provenance.json', 'utf8'));
const files = new Map(provenance.files.map(item => [item.file, item.sha256]));
const dmgName = (await readdir(path.join(bundle, 'dmg'))).filter(name => name.endsWith('.dmg'));
if (dmgName.length !== 1) throw Error(`Expected one DMG, got ${dmgName.length}`);
const dmg = path.join(bundle, 'dmg', dmgName[0]);
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const assertHash = async (file, key) => {
  if (!files.has(key) || await hash(file) !== files.get(key)) throw Error(`Build provenance mismatch: ${key}`);
};
await assertHash(dmg, `dmg/${dmgName[0]}`);

const temp = await mkdtemp(path.join(os.tmpdir(), 'manga-mac-distribution-'));
const mount = path.join(temp, 'mounted');
const installed = path.join(temp, 'installed', 'Manga Mac.app');
let attached = false;
try {
  await mkdir(mount);
  execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { stdio: 'pipe' });
  attached = true;
  const source = path.join(mount, 'Manga Mac.app');
  await stat(source);
  await mkdir(path.dirname(installed));
  execFileSync('ditto', [source, installed]);
  const contents = path.join(installed, 'Contents', 'MacOS');
  const binary = path.join(contents, 'manga-mac');
  const helpers = (await readdir(contents)).filter(name => /^manga-engine(?:-aarch64-apple-darwin)?$/.test(name));
  if (helpers.length !== 1) throw Error(`Expected one installed image helper, got ${helpers.length}`);
  await assertHash(binary, 'macos/Manga Mac.app/Contents/MacOS/manga-mac');
  await assertHash(path.join(contents, helpers[0]), `macos/Manga Mac.app/Contents/MacOS/${helpers[0]}`);

  const report = JSON.parse(execFileSync(binary, ['--acceptance-preflight'], { encoding: 'utf8' }));
  if (report.runtimeKind !== 'app-bundle' || report.readOnly !== true ||
      report.helper?.sha256 !== await hash(path.join(contents, helpers[0])) ||
      report.checks?.some(check => check.required && check.status !== 'PASS') ||
      report.checks?.find(check => check.id === 'model_cache')?.status !== 'NOT_RUN') {
    throw Error('Installed app preflight did not confirm the bundled helper and read-only checks');
  }
  console.log('DMG copy, executable and helper hashes, and installed app preflight passed.');
} finally {
  if (attached) execFileSync('hdiutil', ['detach', mount], { stdio: 'pipe' });
  await rm(temp, { recursive: true, force: true });
}
