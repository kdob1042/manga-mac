import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));
test('shot UI creates three angle candidates, then exports a brief before yielding to Codex',async({page})=>{
 await page.goto('/');
 await page.evaluate(async legacy=>{
  const {default:React}=await import('/node_modules/.vite/deps/react.js'),{default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {default:View}=await import('/src/ShotControls.jsx');
  const target={instance:'gui',epoch:'e',file:'/working.blend',scene:'Scene',view_layer:'ViewLayer'};
  const current={current:{...legacy,history:[],panels:[{...legacy.panels[0],id:'p',live_binding:target}]}};
  const holder=document.createElement('div');holder.id='scene-workflow';document.body.prepend(holder);
  const root=ReactDOM.createRoot(holder);let revision=1,number=0;window.workflowErrors=[];window.workflowCalls=[];
  const png=legacy.characters[0].image;
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(atob(png.split(',')[1]),c=>c.charCodeAt(0))))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const state=()=>({...target,revision,objects:[{id:'actor',name:'Actor',type:'MESH'},{id:'cam',name:'Camera',type:'CAMERA'}],next_offset:null,control:'manual'});
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   window.workflowCalls.push({command,action:args?.action});
   if(command==='blender_live')return {...state(),evaluated_world:[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]};
   if(command==='blender_live_candidate'){revision++;number++;return {session_id:`s${number}`,request_id:`r${number}`,preview:png,live_observation:state(),state:{dependencies_pinned:true,checkpoint:{hash:'a'.repeat(64)},image:{hash},state:{scene:'Scene'},scenes:[{name:'Scene',objects:['Actor','Camera']}]}};}
   if(command==='export_file'){window.briefExport=args;return '/Downloads/scene-brief.zip';}
   throw Error('Unexpected '+command);
  }};
  const render=()=>root.render(React.createElement(View,{project:current.current,current,chosen:current.current.panels[0],busy:false,commit:async p=>{current.current=p;window.workflowProject=p;render();},run:async(_,fn)=>{try{await fn();}catch(e){window.workflowErrors.push(e.message);}}}));render();
 },legacy);
 const view=page.locator('#scene-workflow');await view.getByText('同じシーンのアングル候補を作る',{exact:true}).click();
 await view.getByRole('button',{name:'注視対象を読み込む',exact:true}).click();
 await view.getByLabel('注視対象',{exact:true}).selectOption('Actor');
 await view.getByRole('button',{name:'アングル候補を撮影',exact:true}).click();
 await expect(view.getByRole('img',{name:/度の候補/})).toHaveCount(3);
 expect(await page.evaluate(()=>window.workflowProject.live_candidates.length)).toBe(3);
 await view.getByRole('button',{name:'MacのCodexへ渡す',exact:true}).click();
 await expect(view).toContainText('/Downloads/scene-brief.zip');
 const result=await page.evaluate(()=>({errors:window.workflowErrors,calls:window.workflowCalls,zip:window.briefExport?.name}));
 expect(result.errors).toEqual([]);expect(result.zip).toMatch(/^scene-brief-.*\.zip$/);
 const exported=result.calls.findIndex(c=>c.command==='export_file'),yielded=result.calls.findIndex(c=>c.action==='yield');
 expect(exported).toBeGreaterThan(-1);expect(yielded).toBeGreaterThan(exported);
 await page.screenshot({path:'test-results/scene-workflow.png',fullPage:true});
});
