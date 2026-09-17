import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));

test('one action directs four isolated shots, draws them, and edits without a face model', async ({ page }) => {
  await page.addInitScript(({ legacy }) => {
    let project = { ...legacy, title:'自動演出テスト', history:[], jobs:[], panels:Array.from({length:4},(_,i)=>({...legacy.panels[0],id:`s:p${i}`,unitIds:[`s:u${i}`],image:null,attempts:0,instructions:[]})), snapshots:[{...legacy.snapshots[0],scenes:[{id:'s',text:'駅の全景。\n\n人物Aが話す。\n\n人物Aが笑う。\n\n静かな余韻。',design:''}]}] };
    const sessions = {}, calls = []; window.nativeCalls = calls;
    const hash = 'a'.repeat(64);
    const state = { dependencies_pinned:true,checkpoint:{hash},operations:['catalog','camera','capture'],library_assets:[],assets:[],state:{scene:'Stage',camera:'Camera',frame:1,lens:35,resolution:[768,768]},scenes:[{name:'Stage',cameras:['Camera'],objects:['Actor']}] };
    const png = (color, width=768, height=768) => { const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);return c.toDataURL('image/png'); };
    const imageHash = async image => [...new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(atob(image.split(',')[1]), c=>c.charCodeAt(0))))].map(b=>b.toString(16).padStart(2,'0')).join('');
    window.__TAURI_INTERNALS__ = { invoke:async(command,args)=>{
      calls.push({command,args});
      if(command==='load_project') return JSON.stringify(project);
      if(command==='save_project') {project=JSON.parse(args.data);window.savedProject=project;return;}
      if(command==='backup_status') return {config:null,status:{},restored:[]};
      if(command==='register_llm') return 'planner';
      if(command==='remove_llm') return;
      if(command==='llm_request') {
        const r=args.request;
        if(r.purpose==='probe') return {request_id:r.request_id,value:{ok:true}};
        if(r.purpose==='layout'){const payload=JSON.parse(r.prompt);return {request_id:r.request_id,value:{reason:'配置を維持',pages:payload.pages}};}
        if(r.purpose==='lettering')return {request_id:r.request_id,value:{reason:'本文を配置',layout:JSON.parse(r.prompt).current}};
        if(r.purpose!=='direction') throw Error('Unexpected AI purpose');
        const payload=JSON.parse(r.prompt.split('\n').at(-1));
        return {request_id:r.request_id,value: payload.completed.some(o=>o.kind==='camera') ? {status:'ready',reason:'構図を確認、撮影へ',operation:null} : {status:'action',reason:'人物へ寄ります',operation:{kind:'camera',lens:70}}};
      }
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
  await page.getByRole('button',{name:'✧ 漫画にする',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'初稿 1ページを表示しました。'})).toBeVisible({timeout:30000});
  const saved=await page.evaluate(()=>window.savedProject);
  expect(saved.captures).toHaveLength(4);expect(saved.panels.every(p=>p.image&&p.shot_binding)).toBe(true);
  expect(new Set(saved.panels.map(p=>p.shot_binding.session_id)).size).toBe(4);
  await page.screenshot({path:'test-results/ai-directed-manga.png'});
  await page.getByRole('button',{name:'確認を閉じる',exact:true}).click();
  await page.locator('.panel').first().click();
  await page.getByLabel('編集の指示',{exact:true}).fill('口元を修正');
  const box=await page.locator('.panel .art').first().boundingBox();
  await page.mouse.move(box.x+box.width*.25,box.y+box.height*.25);await page.mouse.down();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.up();
  await page.getByRole('button',{name:'修正する ↑',exact:true}).click();
  await expect.poll(() => page.evaluate(() => window.savedProject.jobs.filter(j => j.kind === 'edit' && j.status === 'candidate').length)).toBe(1);
  await page.getByRole('button',{name:'この候補を採用',exact:true}).click();
  await expect.poll(() => page.evaluate(() => window.savedProject.jobs.filter(j => j.kind === 'edit' && j.status === 'complete').length)).toBe(1);
  const after=await page.evaluate(()=>window.savedProject);
  expect(after.panels[0].image).not.toBe(saved.panels[0].image);
  expect(after.panels.slice(1).map(p=>p.image)).toEqual(saved.panels.slice(1).map(p=>p.image));
  const requests=await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='llm_request').map(c=>c.args.request.purpose));
  expect(requests.every(p=>['probe','direction','layout','lettering'].includes(p))).toBe(true);
});
