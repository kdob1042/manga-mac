import {execFileSync} from 'node:child_process';
import {defineConfig} from 'vite';

function buildCommit() {
  if (/^[a-f0-9]{40}$/i.test(process.env.VITE_BUILD_SHA ?? '')) return process.env.VITE_BUILD_SHA;
  try { return execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); }
  catch { return '未記録'; }
}

export default defineConfig({define:{'import.meta.env.VITE_BUILD_SHA':JSON.stringify(buildCommit())}});
