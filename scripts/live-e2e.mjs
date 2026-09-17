// Actual browser/Canvas exporter -> native atomic exporter. Artificial calibration media only.
import {chromium} from 'playwright';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=fs.mkdtempSync(join(tmpdir(),'live-e2e-input-')),mp4=join(dir,'motion.mp4'),png=join(dir,'poster.png');
const pattern='color=c=blue:s=512x512:r=24,drawbox=x=0:y=0:w=256:h=256:color=red:t=fill,drawbox=x=256:y=256:w=256:h=256:color=yellow:t=fill';
execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i',pattern,'-frames:v','1',png]);
execFileSync('ffmpeg',['-v','error','-y','-loop','1','-i',png,'-r','24','-t','5','-c:v','libx264','-pix_fmt','yuv420p',mp4]);
const bytes=fs.readFileSync(mp4),hash=crypto.createHash('sha256').update(bytes).digest('hex');
const legacy=JSON.parse(fs.readFileSync('tests/fixtures/legacy-v1.json'));
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--port','5181','--host','127.0.0.1'],{stdio:'ignore'});let browser;
try{
 let ready=false;for(let i=0;i<100;i++){try{const r=await fetch('http://127.0.0.1:5181');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('Exporter server did not start');
 browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']}:{});
 const page=await browser.newPage();await page.goto('http://127.0.0.1:5181');
 const payload=await page.evaluate(async({legacy,hash,size,poster})=>{
  const {migrateProject}=await import('/src/revisions.js');
  const {shotFromPanel,assignMotion}=await import('/src/panel-motion.js');
  const {beginVideoJob,collectVideoResult,adoptVideoCandidate}=await import('/src/video.js');
  const {prepareLiveManga}=await import('/src/live-export.js');
  const {prepareBrowserPreview}=await import('/src/LivePreviewControls.jsx');
  const {imageOf}=await import('/src/canvas-image.js');
  const {template}=await import('/src/layout.js');
  const {pagePNG}=await import('/src/render.js');
  legacy.title='Artificial 4/6-panel crop calibration';
  legacy.snapshots[0].scenes[0].text='Calibration text.\n\nArtificial fixture.';
  legacy.panels=Array.from({length:10},(_,i)=>({...legacy.panels[0],id:`s:p${i}`,image:poster}));legacy.history=[];
  let p=await migrateProject(legacy);p.revision=7;
  p.layout={version:1,knownPanelIds:p.panels.map(p=>p.id),pages:[{id:'four',slots:template(4,p.panels.slice(0,4).map(p=>p.id))},{id:'six',slots:template(6,p.panels.slice(4).map(p=>p.id))}],imageCrops:{'s:p0':{zoom:1.25,x:.2,y:.75},'s:p4':{zoom:2,x:.8,y:.1}}};
  p.layout.pages[0].slots[0].points[0][0]+=.06;
  p.layout.pages[0].slots[0].points[2][0]-=.04;
  p.layout.pages[1].slots[0].points[1][0]-=.05;
  // One cropped four-panel shot, a contained shot, and a cropped six-panel shot.
  for(const index of [0,1,4]){
   p=await shotFromPanel(p,p.panels[index].id,'校正用の人工動画','960:960');
   const shot=p.videoShots.at(-1),start=await beginVideoJob(p,shot.id,{id:'test',provider:'runway',model:'gen4.5'});
   p=collectVideoResult(start.project,start.job.id,{artifact_id:hash,hash,mime:'video/mp4',size});p=await adoptVideoCandidate(p,start.job.id,async()=>{});p=await assignMotion(p,p.panels[index].id,shot.id);
  }
  const request=await prepareLiveManga(p,async()=>({width:512,height:512,duration:5,codec:'h264',audio:false}));
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  for(const [index,pg] of request.manifest.pages.entries()){
   const layoutPage=p.layout.pages[index],panels=layoutPage.slots.map(s=>p.panels.find(p=>p.id===s.panelId));
   if(await pagePNG(panels,p.snapshots,p.localizations,p.output_locale,layoutPage,false,p.layout.imageCrops)!==request.sources[pg.fallback].image)throw Error('PNG export differs from publication fallback');
   canvas.width=pg.width;canvas.height=pg.height;ctx.drawImage(await imageOf(request.sources[pg.art].image),0,0);ctx.drawImage(await imageOf(request.sources[pg.overlay].image),0,0);
   const layered=ctx.getImageData(0,0,pg.width,pg.height).data;ctx.clearRect(0,0,pg.width,pg.height);ctx.drawImage(await imageOf(request.sources[pg.fallback].image),0,0);const complete=ctx.getImageData(0,0,pg.width,pg.height).data;
   // Independent Canvas composites can differ by one rounding level at antialias edges.
   let different=0;for(let i=0;i<layered.length;i++)if(Math.abs(layered[i]-complete[i])>2)different++;
   if(different>pg.width*pg.height*.002)throw Error(`Reader layers differ from PNG (${different} channels)`);
  }
  const previewProject=structuredClone(p);previewProject.workId='artificial';
  const {legacyPanelRefs}=await import('/src/source-refs.js');
  previewProject.snapshots[0].scenes[0].tags=['雨'];
  previewProject.snapshots[0].scenes.push({id:'library',text:'図書館。',tags:['図書館']});
  for(const panel of previewProject.panels){panel.sourceRefs=legacyPanelRefs(panel,previewProject.snapshots);panel.lettering=null;}
  previewProject.panels[0].lettering={mode:'caption'};
  const libraryRef={snapshotId:previewProject.snapshots[0].id,sceneId:'library',startCp:0,endCp:4};
  previewProject.panels[2].sourceRefs=[libraryRef];previewProject.panels[5].sourceRefs.push(libraryRef);
  previewProject.secret='PRIVATE_PREVIEW_CANARY';
  previewProject.panels[2].image=null;previewProject.panels[3].unitIds=[];previewProject.panels[3].sourceRefs=[];previewProject.panels[3].lettering=null;
  // No API/model calls: only already-created artificial video is probed.
  window.__TAURI_INTERNALS__={invoke:async command=>{if(command==='live_preview_video_probe')return {width:512,height:512,duration:5,codec:'h264',audio:false};throw Error('Unexpected preview call: '+command);}};
  const preview=await prepareBrowserPreview({project:previewProject,revision:crypto.randomUUID(),savedAt:'2026-09-17T00:00:00.000Z'});
  return {project:p,request,previewProject,preview};
 },{legacy,hash,size:bytes.length,poster:'data:image/png;base64,'+fs.readFileSync(png).toString('base64')});
 payload.video=bytes.toString('base64');const input=join(dir,'request.json');fs.writeFileSync(input,JSON.stringify(payload));
 const output=process.env.LIVE_MANGA_E2E_OUTPUT??join(dir,'output');
 execFileSync('cargo',['test','--locked','--manifest-path','tests/storage/Cargo.toml','browser_export_request_integration','--','--ignored','--nocapture'],{env:{...process.env,LIVE_MANGA_E2E_REQUEST:input,LIVE_MANGA_E2E_OUTPUT:output},stdio:'inherit'});
 const packagePath=join(output,'live-manga-'+payload.request.manifest.releaseId);
 const {verifyPackage}=await import('../vendor/live-manga/contracts/package.mjs');await verifyPackage(packagePath);
 const {exercisePreviewPackage}=await import('./preview-e2e.mjs');
 await exercisePreviewPackage(join(output,'live-manga-'+payload.preview.preview.manifest.releaseId));
 if(process.env.LIVE_MANGA_E2E_RESULT)fs.writeFileSync(process.env.LIVE_MANGA_E2E_RESULT,JSON.stringify({path:packagePath,releaseId:payload.request.manifest.releaseId}));
 console.log('LIVE_MANGA_PACKAGE='+packagePath);
}finally{if(browser)await browser.close();server.kill();}
