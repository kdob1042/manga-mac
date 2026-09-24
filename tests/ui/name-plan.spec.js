import {test,expect} from '@playwright/test';
import {writeFileSync} from 'node:fs';

async function setup(page,openControls=true) {
  await page.goto('/');
  await page.evaluate(async()=>{
    const {emptyProject}=await import('/src/core.js');const {fileFixture}=await import('/tests/name-plan-fixture.mjs');
    const f=await fileFixture(2,'# Scene\n\n彼は手を振る。\n\n「また明日」');
    const p={...emptyProject(),...f.project,title:'ネーム統合確認',contentToken:'browser-fixture'};
    await (await import('/src/bridge.js')).saveProject(p);
  });
  await page.reload();if(openControls)await page.getByText('制作する場面・ネーム・保存した原稿',{exact:true}).click();
  return page.evaluate(async()=>{const {loadProject}=await import('/src/bridge.js'),{fileFixture}=await import('/tests/name-plan-fixture.mjs'),{createNameFile}=await import('/src/name-v2.js');const f=await fileFixture(2,'# Scene\n\n彼は手を振る。\n\n「また明日」');return createNameFile(await loadProject(),f.plan,null,{producer:'fixture',model:'',editedBy:[]});});
}
test('actual UI imports, previews printed text and persists adoption without AI calls',async({page})=>{
  const file=await setup(page);
  await page.getByLabel('ネームJSONを取り込む',{exact:true}).setInputFiles({name:'name.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(file))});
  await expect(page.getByRole('button',{name:'このネーム候補を採用',exact:true})).toBeVisible();
  await expect(page.getByAltText('実際のコマ枠と掲載文字による仮ネーム')).toBeVisible();
  await expect(page.getByRole('button',{name:'プレビューを更新',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'このネーム候補を採用',exact:true}).click();
  await expect(page.getByRole('button',{name:'このネームで制作',exact:true})).toBeVisible();
  const p=await page.evaluate(async()=>JSON.parse(JSON.stringify(await (await import('/src/bridge.js')).loadProject())));
  expect(p.namePlan.status).toBe('adopted');expect(p.panels.length).toBe(2);expect(p.panels[0].requiredText).toEqual([]);expect(p.panels[1].requiredText.length).toBe(1);expect(p.sourceApplication.units).toEqual([]);
  expect(p.jobs.some(job=>['generate','retake'].includes(job.kind))).toBe(false);
  await page.reload();await page.getByText('制作する場面・ネーム・保存した原稿',{exact:true}).click();
  await page.getByRole('button',{name:'実文字入り仮ネームを確認'}).click();
  await page.screenshot({path:'test-results/name-plan-import.png',fullPage:true});
});

test('real production stages, renderer, IndexedDB restore and CBZ preserve adopted name',async({page})=>{
  const file=await setup(page);
  await page.getByLabel('ネームJSONを取り込む',{exact:true}).setInputFiles({name:'name.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(file))});
  await page.getByRole('button',{name:'このネーム候補を採用',exact:true}).click();
  const result=await page.evaluate(async()=>{
    const {loadProject,saveProject}=await import('/src/bridge.js'),{produceDraft}=await import('/src/production.js'),{pagePNG}=await import('/src/render.js'),{imageOf}=await import('/src/canvas-image.js'),{exportCBZ}=await import('/src/export.js');
    let p=await loadProject(),calls={images:0,lettering:0,planning:0},before=JSON.stringify(p.layout),proof;
    const generate=async panel=>{calls.images++;const canvas=document.createElement('canvas');[canvas.width,canvas.height]=panel.generationResolution;const ctx=canvas.getContext('2d');ctx.fillStyle='#ddd';ctx.fillRect(0,0,canvas.width,canvas.height);return {...panel,image:canvas.toDataURL('image/png'),generation:{width:canvas.width,height:canvas.height}};};
    await produceDraft({current:()=>p,commit:async next=>{p=await saveProject(next);return p;},cancelled:()=>false,model:{visualEditing:false},productionMode:'direct',setBusy:()=>{},setNotice:()=>{},showProof:image=>{proof=image;},stagePanel:()=>{throw Error('must not use Blender');},planScene:()=>{calls.planning++;throw Error('must not replan');},generatePanel:generate,askLLM:async(_model,{prompt,purpose})=>{if(purpose!=='lettering')throw Error('unexpected LLM');calls.lettering++;return JSON.stringify({reason:'人工応答：既存枠を保持',layout:JSON.parse(prompt).current});},imageOf,pagePNG,imageModelId:p.mediaDefaults.image});
    const restored=await loadProject(),zip=await exportCBZ(restored);
    return {calls,sameLayout:JSON.stringify(restored.layout)===before,sourceUnits:restored.sourceApplication.units,ready:restored.namePlan.productionState,proof,zipBytes:zip.size,project:restored};
  });
  expect(result.calls).toEqual({images:2,lettering:1,planning:0});expect(result.sameLayout).toBe(true);expect(result.ready).toBe('proof-ready');expect(result.sourceUnits[0].requiredText).toEqual([]);expect(result.zipBytes).toBeGreaterThan(100);
  writeFileSync('test-results/name-plan-produced.png',Buffer.from(result.proof.split(',')[1],'base64'));
  writeFileSync('test-results/name-plan-v2-project.json',JSON.stringify(result.project,null,2));
});

test('whole-page splash proof uses same renderer at mobile widths',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {fileFixture}=await import('/tests/name-plan-fixture.mjs'),{createNameCandidate,adoptNameCandidate}=await import('/src/name-v2.js'),{pagePNG}=await import('/src/render.js');
  const f=await fileFixture(1);f.file.plan.panels[0].role='splash';const p=await adoptNameCandidate(f.project,await createNameCandidate(f.project,f.file));
  return {png:await pagePNG(p.panels,p.snapshots,[],'ja',p.layout.pages[0],true),points:p.layout.pages[0].slots[0].points,panels:p.panels.length};
 });
 expect(result.panels).toBe(1);expect(result.points[0][0]).toBeLessThan(.05);writeFileSync('test-results/name-plan-splash.png',Buffer.from(result.png.split(',')[1],'base64'));
 for(const width of [375,430,1024]){await page.setViewportSize({width,height:900});await page.setContent(`<img alt="仮ネーム" src="${result.png}" style="width:100%;height:auto">`);await expect(page.getByAltText('仮ネーム')).toBeVisible();}
});


test('name controls load on first expansion and retain the draft when closed',async({page})=>{
  const requests=[];
  page.on('request',request=>{if(request.url().includes('/src/NamePlanControls.jsx'))requests.push(request.url());});
  await setup(page,false);
  expect(requests).toEqual([]);
  const disclosure=page.getByText('制作する場面・ネーム・保存した原稿',{exact:true});
  await disclosure.click();
  await page.getByText('ネームがない場合の代替生成',{exact:true}).click();
  const instruction=page.getByLabel('ネームの演出指示',{exact:true});
  await instruction.fill('最後の表情に一拍。');
  expect(requests.length).toBeGreaterThan(0);
  await disclosure.click();
  await expect(instruction).toBeHidden();
  await disclosure.click();
  await expect(instruction).toHaveValue('最後の表情に一拍。');
});
