import {test,expect} from '@playwright/test';
async function mount(page,oldText='A\n\nB\n\nC',newText='A\n\nX\n\nZ\n\nB\n\nC\n\nY'){
 await page.goto('/');
 await page.evaluate(async({oldText,newText})=>{
  const {default:React}=await import('/node_modules/.vite/deps/react.js'),{default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {default:View}=await import('/src/SourceManuscript.jsx'),{tokenizeSnapshot}=await import('/src/source-refs.js');
  const snapshots=[{id:'old',scenes:[{id:'S',text:oldText}]},{id:'new',scenes:[{id:'S',text:newText}]}];
  window.sourceProject={workId:'workA',contentToken:'token1',active:'new',snapshots,panels:[],sourceApplication:{version:1,units:tokenizeSnapshot(snapshots[0]).map((u,i)=>({id:`u${i}`,source:u.source,requiredText:[u.source]}))}};
  window.appliedSelections=[];window.aiRequests=[];window.__TAURI_INTERNALS__={invoke:async command=>{window.aiRequests.push(command);throw Error('unexpected native call');}};
  const container=document.createElement('div');container.id='source-fixture';document.body.prepend(container);const root=ReactDOM.createRoot(container);
  window.renderSource=()=>root.render(React.createElement(View,{project:structuredClone(window.sourceProject),busy:!!window.sourceBusy,current:()=>window.sourceProject,onApply:selection=>window.appliedSelections.push(selection)}));window.renderSource();
 },{oldText,newText});
 return page.locator('#source-fixture');
}
test('real diff groups added paragraphs; selection carries only IDs and base; partial adoption and undo derive residuals',async({page})=>{
 const view=await mount(page),checks=view.getByRole('checkbox');await expect(checks).toHaveCount(2);
 await checks.first().check();await expect(view.getByRole('status')).toHaveText('1 / 2 ブロックを選択');
 await expect(view.locator('.source-addition').first()).toContainText('X\n\nZ');
 await view.getByRole('button',{name:'選択箇所を漫画に反映',exact:true}).click();
 const selection=await page.evaluate(()=>window.appliedSelections[0]);expect(Object.keys(selection).sort()).toEqual(['baseContentToken','changeSetId','selectedBlockIds','targetSnapshotId']);expect(selection.selectedBlockIds).toHaveLength(1);
 await page.evaluate(async()=>{const {buildChangeSet,buildExpectedApplication}=await import('/src/source-diff.js');const p=window.sourceProject;window.beforeSource=structuredClone(p);p.sourceApplication.units=buildExpectedApplication(p,buildChangeSet(p),window.appliedSelections[0].selectedBlockIds).afterUnits;p.contentToken='token2';window.renderSource();});
 await expect(checks).toHaveCount(1);await expect(view.locator('.source-addition')).toContainText('Y');await expect(view.getByRole('status')).toHaveText('0 / 1 ブロックを選択');
 await page.evaluate(()=>{window.sourceProject=window.beforeSource;window.renderSource();});await expect(checks).toHaveCount(2);await expect(view.getByRole('status')).toHaveText('0 / 2 ブロックを選択');
 await checks.first().focus();await page.keyboard.press('Space');await expect(checks.first()).toBeChecked();
 await view.getByRole('button',{name:'未反映・削除対象をすべて選択'}).click();await expect(view.getByRole('status')).toHaveText('2 / 2 ブロックを選択');
 await view.getByRole('button',{name:'全解除',exact:true}).click();expect(await page.evaluate(()=>window.aiRequests.length)).toBe(0);
});
test('old text has labeled red deletion and replacement; work switch and stale base cannot submit',async({page})=>{
 const view=await mount(page,'DELETED\n\nA\n\nold B\n\nC','A\n\nnew B\n\nC');
 await expect(view.locator('.source-deletion').first()).toContainText('DELETED');
 expect(await view.locator('.source-deletion').first().evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(251, 232, 233)');
 await expect(view.locator('.source-change').nth(1)).toContainText('old B');await expect(view.locator('.source-change').nth(1)).toContainText('new B');
 await view.getByRole('checkbox').first().check();
 await page.evaluate(()=>{window.sourceProject.contentToken='stale';});
 await view.getByRole('button',{name:'選択箇所を漫画に反映',exact:true}).click();await expect(view.getByRole('alert')).toContainText('選択し直して');
 expect(await page.evaluate(()=>window.appliedSelections.length)).toBe(0);
 await page.evaluate(()=>{window.sourceProject.workId='workB';window.renderSource();});await expect(view.getByRole('status')).toHaveText('0 / 2 ブロックを選択');
 await expect(view.getByRole('button',{name:'選択箇所を漫画に反映',exact:true})).toBeDisabled();
});
test('first draft, empty target and moves remain block operations',async({page})=>{
 let view=await mount(page,'','A\n\nB');await expect(view.getByRole('checkbox')).toHaveCount(1);await expect(view.locator('.source-applied')).toHaveCount(0);
 view=await mount(page,'A\n\nB','');await expect(view.getByRole('checkbox')).toHaveCount(1);await expect(view.locator('.source-deletion')).toContainText('A\n\nB');
 view=await mount(page,'A\n\nB\n\nC\n\nD','B\n\nC\n\nD\n\nA');
 await expect(view.getByRole('button',{name:'移動元・移動先をまとめて選択'})).toBeVisible();await view.getByRole('button',{name:'移動元・移動先をまとめて選択'}).click();await expect(view.getByRole('checkbox')).toBeChecked();await expect(view.getByRole('status')).toHaveText('1 / 1 ブロックを選択');
 await page.evaluate(()=>{window.sourceBusy=true;window.renderSource();});await expect(view.getByRole('checkbox')).toBeDisabled();
 await page.screenshot({path:'test-results/source-move.png',fullPage:true});
});
