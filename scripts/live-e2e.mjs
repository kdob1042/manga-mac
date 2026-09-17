// Real browser exporter -> real native exporter. No AI/API calls.
import {chromium} from 'playwright';import fs from 'node:fs';import crypto from 'node:crypto';import {spawn,execFileSync} from 'node:child_process';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'live-e2e-input-')),mp4=join(dir,'motion.mp4');execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=64x64:r=24','-t','5','-c:v','libx264','-pix_fmt','yuv420p',mp4]);const bytes=fs.readFileSync(mp4),hash=crypto.createHash('sha256').update(bytes).digest('hex');const legacy=JSON.parse(fs.readFileSync('tests/fixtures/legacy-v1.json'));
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--port','5181','--host','127.0.0.1'],{stdio:'ignore'});let browser;
try{
 for(let i=0;i<100;i++){try{await fetch('http://127.0.0.1:5181');break;}catch{await new Promise(r=>setTimeout(r,100));}}
 browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']}:{});const page=await browser.newPage();await page.goto('http://127.0.0.1:5181');
 const payload=await page.evaluate(async({legacy,hash,size})=>{
  const {migrateProject}=await import('/src/revisions.js');const {shotFromPanel,assignMotion}=await import('/src/panel-motion.js');const {beginVideoJob,collectVideoResult,adoptVideoCandidate}=await import('/src/video.js');const {prepareLiveManga}=await import('/src/live-export.js');const {imageOf}=await import('/src/canvas-image.js');
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle='blue';ctx.fillRect(0,0,64,64);
  legacy.panels=Array.from({length:4},(_,i)=>({...legacy.panels[0],id:`s:p${i}`,image:canvas.toDataURL()}));legacy.history=[];
  let p=await migrateProject(legacy);p.revision=7;p=await shotFromPanel(p,p.panels[0].id,'少し動く','960:960');const start=await beginVideoJob(p,p.videoShots[0].id,{id:'test',provider:'runway',model:'gen4.5'});p=collectVideoResult(start.project,start.job.id,{artifact_id:hash,hash,mime:'video/mp4',size});p=await adoptVideoCandidate(p,start.job.id,async()=>{});p=await assignMotion(p,p.panels[0].id,p.videoShots[0].id);
  const request=await prepareLiveManga(p,async()=>({width:64,height:64,duration:5,codec:'h264',audio:false}));const pg=request.manifest.pages[0];
  canvas.width=pg.width;canvas.height=pg.height;ctx.drawImage(await imageOf(request.sources[pg.art].image),0,0);ctx.drawImage(await imageOf(request.sources[pg.overlay].image),0,0);const layered=ctx.getImageData(0,0,pg.width,pg.height).data;ctx.clearRect(0,0,pg.width,pg.height);ctx.drawImage(await imageOf(request.sources[pg.fallback].image),0,0);const complete=ctx.getImageData(0,0,pg.width,pg.height).data;if(layered.some((n,i)=>n!==complete[i]))throw Error('PNG and reader layers differ');
  return {project:p,request};
 },{legacy,hash,size:bytes.length});payload.video=bytes.toString('base64');const input=join(dir,'request.json');fs.writeFileSync(input,JSON.stringify(payload));
 const output=process.env.LIVE_MANGA_E2E_OUTPUT??join(dir,'output');
 execFileSync('cargo',['test','--locked','--manifest-path','tests/storage/Cargo.toml','browser_export_request_integration','--','--ignored','--nocapture'],{env:{...process.env,LIVE_MANGA_E2E_REQUEST:input,LIVE_MANGA_E2E_OUTPUT:output},stdio:'inherit'});
 const {verifyPackage}=await import('../vendor/live-manga/contracts/package.mjs');await verifyPackage(join(output,'live-manga-'+payload.request.manifest.releaseId));
 console.log('LIVE_MANGA_PACKAGE='+join(output,'live-manga-'+payload.request.manifest.releaseId));
}finally{if(browser)await browser.close();server.kill();}
