#!/usr/bin/env node
// Local, read-only diagnostics for a name plan. Chat AI remains the author.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateSourceTree, manifestToSourceModel} from '../../contracts/story-source/validate.mjs';
import {hasEmbeddedSource} from '../../contracts/name-plan/source.mjs';
import {emptyProject} from '../../src/core.js';
import {MAX_BYTES} from '../../contracts/name-plan/schema.mjs';
import {createNameCandidate} from '../../src/name-v2.js';

function argumentsOf(argv) {
  if (!argv.length || argv.length%2 || argv.some((value,index)=>index%2===0&&!['--project','--plan','--source-bundle'].includes(value))) throw Error('usage: validate.mjs --plan name-001.json [--project PROJECT.json --source-bundle SOURCE.json]');
  const options=Object.fromEntries(Array.from({length:argv.length/2},(_,i)=>[argv[i*2],argv[i*2+1]]));
  if(!options['--plan']||Object.keys(options).length!==argv.length/2)throw Error('planを一つ指定してください');
  return options;
}

async function json(path, maximum = 16 * 1024 * 1024) {
  const content = await readFile(resolve(path));
  if (content.length > maximum) throw Object.assign(Error('検証ファイルが大きすぎます'), {code:'size'});
  return JSON.parse(content.toString('utf8'));
}

export async function validateInputs({project, plan, bundle}) {
  if(hasEmbeddedSource(plan)){
    const candidate=await createNameCandidate(project??emptyProject(),plan);
    return {ok:true,format:candidate.file.format,sourceScenes:candidate.file.source.scenes.length,panels:candidate.panels.length,pages:candidate.layout.pages.length,diagnostics:candidate.diagnostics};
  }
  // The production source contract checks declared file coverage and headings.
  if (!bundle || !bundle.manifest || !bundle.files) throw Object.assign(Error('source-bundleにはmanifestとfilesが必要です'), {code:'source'});
  const source = validateSourceTree(bundle?.manifest, bundle?.files);
  const model = manifestToSourceModel(source.manifest);
  const snapshot = project?.snapshots?.find(item => item.id === project.active);
  if (!snapshot || !Array.isArray(snapshot.scenes)) throw Object.assign(Error('選択中の原稿がありません'), {code:'source'});
  for (const scene of snapshot.scenes ?? []) {
    const declared = model.scenes.find(item => item.id === scene.id);
    if (!declared || source.files.get(declared.path) !== scene.text) {
      throw Object.assign(Error('検証した原稿と取り込み済み原稿が一致しません'), {code:'source_changed'});
    }
  }
  // The same importer used by manual JSON and pinned GitHub retrieval performs
  // schema, atom/hash, character-ID, policy and layout compiler checks.
  const candidate = await createNameCandidate(project, plan);
  return {
    ok:true, format:candidate.file.format, sourceScenes:snapshot.scenes.length,
    panels:candidate.panels.length, pages:candidate.layout.pages.length,
    fileHash:candidate.fileHash, diagnostics:candidate.diagnostics,
  };
}

async function main() {
  try {
    const options=argumentsOf(process.argv.slice(2));
    const [project,plan,bundle]=await Promise.all([
      options['--project']?json(options['--project']):null,json(options['--plan'],MAX_BYTES),options['--source-bundle']?json(options['--source-bundle']):null,
    ]);
    process.stdout.write(JSON.stringify(await validateInputs({project,plan,bundle}))+'\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ok:false,code:error.code ?? (error instanceof SyntaxError?'json':'validation'),message:error.message})+'\n');
    process.exitCode=1;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
