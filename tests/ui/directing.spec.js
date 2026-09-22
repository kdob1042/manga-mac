import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));

test('production opens its GUI and waits for visual confirmation without background shots', async ({ page }) => {
  await page.addInitScript(({ legacy }) => {
    let project = { ...legacy, title:'自動演出テスト', history:[], jobs:[], panels:Array.from({length:4},(_,i)=>({...legacy.panels[0],id:`s:p${i}`,unitIds:[`s:u${i}`],image:null,attempts:0,instructions:[]})), snapshots:[{...legacy.snapshots[0],scenes:[{id:'s',text:'駅の全景。\n\n人物Aが話す。\n\n人物Aが笑う。\n\n静かな余韻。',design:''}]}] };
    const sessions = {}, calls = []; window.nativeCalls = calls;
    const hash = 'a'.repeat(64);
    const state = { dependencies_pinned:true,checkpoint:{hash},operations:['catalog','camera','capture'],library_assets:[],assets:[],state:{scene:'Stage',camera:'Camera',frame:1,lens:35,resolution:[768,768]},scenes:[{name:'Stage',cameras:['Camera'],objects:['Actor']}] };
    const png = (color, width=768, height=768) => { const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);return c.toDataURL('image/png'); };
    const imageHash = async image => [...new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(atob(image.split(',')[1]), c=>c.charCodeAt(0))))].map(b=>b.toString(16).padStart(2,'0')).join('');
    window.__TAURI_INTERNALS__ = { invoke:async(command,args)=>{
      calls.push({command,args});
      if (command === 'source_library') return {active:'primary',entries:[{id:'primary',name:'Fixture',repo:'example/story',episode:'P01'}]};
      if(command==='load_project') return JSON.stringify({...project,workId:'fixture-work',contentToken:project.contentToken??'fixture-token'});
      if(command==='save_project') {project=JSON.parse(args.data);window.savedProject=project;return;}
      if(command==='prepare_source_patch'){const plan={expected:args.expected,baseContentToken:args.baseContentToken,targetSnapshotId:args.targetSnapshotId,scope:{pageIds:project.layout.pages.map(p=>p.id)}};project.jobs.push({id:args.opId,kind:'sourcePatch',status:'planned',source_patch:plan});return plan;}
   if(command==='commit_source_patch'){const before={panels:project.panels,layout:project.layout,sourceApplication:project.sourceApplication};project={...project,...args.patch,workId:'fixture-work',contentToken:'applied-token',history:[...project.history,{...before,sourcePatch:true,edit:true,after:args.patch}],sourcePatchReceipts:{[args.opId]:true}};project.jobs=project.jobs.map(j=>j.id===args.opId?{...j,status:'complete'}:j);window.saved=project;window.savedProject=project;return project;}
   if(command==='backup_status') return {config:null,status:{},restored:[]};
      if(command==='register_llm') return 'planner';
      if(command==='remove_llm') return;
      if(command==='llm_request') {
        const r=args.request;
        if(r.purpose==='probe') return {request_id:r.request_id,value:{ok:true}};
        if(r.purpose==='layout'){const payload=JSON.parse(r.prompt);return {request_id:r.request_id,value:{reason:'配置を維持',pages:payload.pages}};}
        if(r.purpose==='lettering')return {request_id:r.request_id,value:{reason:'本文を配置',layout:JSON.parse(r.prompt).current}};
        if(r.purpose!=='direction') throw Error('Unexpected AI purpose');
        return {request_id:r.request_id,value:{action:'ready',reason:'見た目を確認してください',scope:'summary',object:'',operation:null}};
      }
      if(command==='blender_gui_start'||command==='blender_live')return {instance:'gui',epoch:'e',revision:1,file:'/working.blend',scene:'Scene',view_layer:'ViewLayer',objects:[],next_offset:null,control:'ai'};
      if(command==='blender_latest') return {session_id:'base',revision:0,state};
      if(command==='blender_fork') return args.ids.map(id=>sessions[id]={session_id:id,revision:0,state:structuredClone(state),jobs:[]});
      if(command==='blender_status') return structuredClone(sessions[args.sessionId]);
      if(command==='blender_execute') {
        const r=args.request,s=sessions[r.session_id];if(r.expected_revision!==s.revision) throw Error('Stale');
        s.revision++;s.jobs.push({id:r.request_id,status:'complete'});
        if(r.operation.kind==='camera') s.state.state.lens=r.operation.lens;
        if(r.operation.kind==='capture') {s.preview=png('#dce6de');s.state.image={hash:await imageHash(s.preview)};s.request_id=r.request_id;}
        return structuredClone(s);
      }
      if(command==='blender_capture') return structuredClone(sessions[args.sessionId]);
      if(command==='generate_image') return png(args.request.recovery.kind==='edit'?'#ff0000':'#577c68',args.request.width,args.request.height);
      throw Error('Unexpected command '+command);
    }};
  }, {legacy});
  await page.goto('/');
  await page.getByRole('button',{name:'接続・人物設定'}).click();
  await expect(page.getByLabel('顔の範囲推定の接続先')).toHaveCount(0);
  await page.getByRole('button',{name:'接続をテスト',exact:true}).click();
  await expect(page.getByText('接続を登録済み（この起動中のみ）')).toBeVisible();
  await page.getByRole('button',{name:'閉じる',exact:true}).click();
  await page.getByLabel('制作方法',{exact:true}).selectOption('blender');
  await page.getByRole('button',{name:'✧ 漫画にする',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'候補保存・採用してから続行'})).toBeVisible();
  const calls=await page.evaluate(()=>window.nativeCalls);
  expect(calls.filter(c=>c.command==='blender_gui_start')).toHaveLength(1);
  expect(calls.some(c=>['blender_execute','blender_fork','generate_image'].includes(c.command))).toBe(false);
  expect(calls.some(c=>c.command==='blender_live'&&c.args.action==='disconnect')).toBe(false);
});
