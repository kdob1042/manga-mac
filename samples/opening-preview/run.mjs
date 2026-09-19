// External private input -> production image helper -> production preview renderer.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {emptyProject, sourceUnits, validatePlan} from '../../src/core.js';
import {generationSize, imageRequest} from '../../src/image-input.js';
import {layoutWarnings} from '../../src/layout.js';
import {legacyPanelRefs} from '../../src/source-refs.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const saveJSON = (p, value) => fs.writeFile(p, JSON.stringify(value, null, 2), {mode:0o600, flag:'wx'});
function helper(executable, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {stdio:['pipe','ignore','pipe'],timeout:15*60*1000,killSignal:'SIGKILL'});
    // Helper diagnostics can contain private inputs; keep them out of CI logs.
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Error(`Image helper exited ${code}`)));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

export async function produce(inputFile, outputDirectory, executable) {
  const {chromium}=await import('playwright');
  const preflight=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
  await preflight.close();
  const input = await readJSON(inputFile), root = path.dirname(path.resolve(inputFile));
  if (!/^[a-zA-Z0-9_-]+$/.test(input.workId) || !/^[a-zA-Z0-9_-]+$/.test(input.episodeId)) throw Error('Invalid work/episode ID');
  if (!Array.isArray(input.panels) || input.panels.length !== 3) throw Error('This opening sample requires exactly three panels');
  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff - 3) throw Error('A reproducible UInt32 seed is required');
  const text = await fs.readFile(path.resolve(root,input.source), 'utf8');
  const units = sourceUnits('opening', text);
  const characters = await Promise.all((input.characters ?? []).map(async c => {
    const bytes = await fs.readFile(path.resolve(root,c.file));
    if (!['image/png','image/jpeg','image/webp'].includes(c.mime)) throw Error('Unsupported reference MIME');
    return {id:c.id,name:c.name,hash:hash(bytes),image:`data:${c.mime};base64,${bytes.toString('base64')}`};
  }));
  // Paragraph indexes are explicit: omissions, repetition and reordering are rejected.
  const plan = {panels:input.panels.map(p => ({...p,unitIds:p.paragraphs.map(i => {
    if (!Number.isInteger(i) || !units[i]) throw Error('Unknown paragraph index');
    return units[i].id;
  })}))};
  validatePlan(plan,units,characters);
  const project = {...emptyProject(),title:input.title,workId:input.workId,revision:1};
  const snapshot = {id:`sample@${hash(text)}`,sha:hash(text),episodeId:input.episodeId,settings:[],scenes:[{id:'opening',text,tags:[]}]};
  project.snapshots=[snapshot];project.active=snapshot.id;project.characters=characters;
  project.panels=plan.panels.map((p,i) => ({...p,id:`opening:p${i}`,snapshotId:snapshot.id,sceneId:'opening',image:null,status:'planned',lettering:{mode:'caption'},instructions:[],attempts:0}));
  for (const p of project.panels) p.sourceRefs=legacyPanelRefs(p,project.snapshots);
  // Wide establishing panel, then tall right panel and a smaller left inset.
  const quads = [ [[.05,.04],[.95,.04],[.95,.40],[.05,.40]], [[.47,.43],[.95,.43],[.95,.95],[.47,.95]], [[.05,.54],[.44,.54],[.44,.88],[.05,.88]] ];
  project.layout={version:1,knownPanelIds:project.panels.map(p=>p.id),pages:[{id:'opening-page',slots:project.panels.map((p,i)=>({id:`slot-${i}`,panelId:p.id,points:quads[i]}))}]};
  const warnings=layoutWarnings(project.layout,project.panels);
  if(warnings.length) throw Error(warnings.join(' / '));
  const out=path.resolve(outputDirectory);
  await fs.mkdir(out,{mode:0o700}); // Refuse to overwrite a previous production attempt.
  await saveJSON(path.join(out,'plan.json'),project);
  for (const [i,panel] of project.panels.entries()) {
    const [width,height]=generationSize(input.panels[i].resolution ?? [[768,384],[512,768],[512,512]][i]);
    const references=panel.characterIds.map(id=>characters.find(c=>c.id===id));
    const request=imageRequest({panel,references,width,height,seed:input.seed+i,instruction:input.instruction ?? ''});
    const requestHash=hash(JSON.stringify(request)), directory=path.join(out,`panel-${i}`);
    await fs.mkdir(directory,{mode:0o700});
    await helper(path.resolve(executable),{...request,output:{directory,request_hash:requestHash}});
    const bytes=await fs.readFile(path.join(directory,'result.png'));
    const receipt=await readJSON(path.join(directory,'receipt.json'));
    if(receipt.request_hash!==requestHash || receipt.hash!==hash(bytes)) throw Error('Image receipt mismatch');
    if(bytes.length<24 || bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a' || bytes.readUInt32BE(16)!==width || bytes.readUInt32BE(20)!==height) throw Error('Image dimensions mismatch');
    panel.image=`data:image/png;base64,${bytes.toString('base64')}`;panel.status='review';panel.attempts=1;
    await saveJSON(path.join(out,`checkpoint-${i}.json`),project);
    console.log(`Verified image ${i+1}/3`);
  }
  await saveJSON(path.join(out,'project.json'),project);
  await render(out);
}

export async function render(directory) {
  const out=path.resolve(directory),project=await readJSON(path.join(out,'project.json'));
  // Export retries never invoke the image model again.
  try {await fs.access(path.join(out,'prepared.json'));throw Error('Prepared output already exists');}
  catch(error) {if(error.code!=='ENOENT')throw error;}
  const {createServer}=await import('vite');
  const {chromium}=await import('playwright');
  const repo=fileURLToPath(new URL('../../',import.meta.url));
  const server=await createServer({root:repo,server:{host:'127.0.0.1',port:0},logLevel:'error'});
  let browser;
  try {
    await server.listen();
    browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
    const page=await browser.newPage();
    await page.goto(server.resolvedUrls.local[0]);
    const result=await page.evaluate(async captured=>{
      const {prepareBrowserPreview}=await import('/src/LivePreviewControls.jsx');
      return prepareBrowserPreview(captured);
    },{project,revision:randomUUID(),savedAt:new Date().toISOString()});
    for(const asset of result.preview.manifest.assets) {
      const data=result.sources[asset.id]?.image;
      if(!data) throw Error('Sample supports still-image assets only');
      const bytes=Buffer.from(data.split(',')[1],'base64');
      if(hash(bytes)!==asset.sha256 || bytes.length!==asset.bytes) throw Error('Rendered asset mismatch');
      await fs.mkdir(path.join(out,'assets'),{recursive:true,mode:0o700});
      const destination=path.join(out,asset.path);
      try {await fs.writeFile(destination,bytes,{flag:'wx',mode:0o600});}
      catch(error) {if(error.code!=='EEXIST'||hash(await fs.readFile(destination))!==asset.sha256)throw error;}
    }
    const pageAsset=result.preview.manifest.assets.find(a=>a.id===result.preview.manifest.pages[0].fallback);
    await fs.copyFile(path.join(out,pageAsset.path),path.join(out,'page.png'));
    await saveJSON(path.join(out,'prepared.json'),result);
    console.log('Prepared page.png and prepared.json; visual review and transfer remain separate.');
  } finally {await browser?.close();await server.close();}
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [input,output,engine]=process.argv.slice(2);
  if(input==='--render'&&output) await render(output);
  else if(!input||!output||!engine) {console.error('Usage: node samples/opening-preview/run.mjs INPUT.json NEW_OUTPUT_DIR MANGA_ENGINE | --render OUTPUT_DIR');process.exitCode=1;}
  else await produce(input,output,engine);
}
