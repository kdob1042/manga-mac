import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const legacy = JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json', import.meta.url)));

test('video capture uses the shared controls without creating manga panels; restart retains the source', async ({ page }) => {
  await page.addInitScript(({ legacy }) => {
    const initial = { ...legacy, panels: [], history: [], jobs: [] };
    const hash = 'a'.repeat(64), image = legacy.characters[0];
    const state = { operations: ['pose', 'capture'], rigs: ['Actor'], assets: [{ kind: 'ACTION', name: 'LeanPose', library: null }], dependencies_pinned: true, checkpoint: { hash }, state: { scene: 'Stage', camera: 'Camera', frame: 1, lens: 50 }, scenes: [{ name: 'Stage', cameras: ['Camera'], objects: ['Actor'] }] };
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      const sessions = JSON.parse(sessionStorage.getItem('fixture-sessions') || '{}');
      if (command === 'source_library') return {active:'primary',entries:[{id:'primary',name:'Fixture',repo:'example/story',episode:'P01'}]};
      if (command === 'load_project') return sessionStorage.getItem('fixture-project') || JSON.stringify(initial);
      if (command === 'save_project') { sessionStorage.setItem('fixture-project', args.data); return; }
      if(command==='blender_live')return {instance:'gui',epoch:'e',revision:1,file:'',scene:'Stage',view_layer:'ViewLayer',objects:[{id:'actor',name:'Actor'}],next_offset:null,control:'manual'};
      if(command==='blender_live_candidate') {
        const result={session_id:'gui-candidate',request_id:'gui-capture',preview:image.image,state:{...state,image:{hash:image.hash},state:{...state.state,resolution:[args.input.width,args.input.height]}}};
        sessionStorage.setItem('gui-result',JSON.stringify(result));return result;
      }
      if(command==='blender_capture')return JSON.parse(sessionStorage.getItem('gui-result'));
      throw Error(`Unexpected fixture IPC: ${command}`);
    } };
  }, { legacy });
  await page.goto('/');
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await page.getByLabel('原作の場面', { exact: true }).selectOption('s');
  await page.getByText('開いているBlender GUIから動画用に撮影', { exact: true }).click();
  await page.getByLabel('撮影する人物', { exact: true }).selectOption(['a']);
  await page.getByRole('button', { name: '動画用の撮影ショットを作る', exact: true }).click();
  await page.getByRole('button',{name:'この撮影を接続中のlive状態へ割り当てる',exact:true}).click();
  await page.getByRole('button',{name:'人物の対応先を読み込む',exact:true}).click();
  await page.getByLabel('人物',{exact:true}).selectOption('a');
  await page.getByLabel('BlenderのObject',{exact:true}).selectOption('actor');
  await page.getByRole('button',{name:'人物と素材を対応付ける',exact:true}).click();
  await page.getByRole('button',{name:'見た目を確認し、新しい候補版へ保存',exact:true}).click();
  await page.getByRole('button', { name: 'この撮影を開始画像に使う', exact: true }).click();
  await page.getByLabel('動きの指示', { exact: true }).fill('カメラを固定する');
  await page.getByRole('button', { name: 'ショットを保存', exact: true }).click();
  await expect(page.locator('.video-source')).toContainText('原文です');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-project')));
  expect(saved.panels).toEqual([]); expect(saved.history).toEqual([]);
  expect(saved.captures).toHaveLength(1); expect(saved.videoShots[0].characterIds).toEqual(['a']);
  expect(saved.captures[0].settings.resolution).toEqual([960, 960]);
  await page.screenshot({ path: 'test-results/video-independent-capture.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: '動画', exact: true }).click();
  await page.getByRole('button', { name: '1 · s', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'このショットの動き', exact: true })).toHaveValue('カメラを固定する');
});
