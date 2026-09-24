import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));
test('production page uses real geometry, source preview, selected panel and persisted approval',async({page})=>{
 await page.goto('/');
 await page.evaluate(async fixture=>{const {saveProject}=await import('/src/bridge.js');await saveProject(fixture);},legacy);
 await page.reload();
 await page.getByRole('button',{name:'コマ割り編集',exact:true}).click();
 await expect(page.getByRole('region',{name:'コマ割り編集'})).toBeVisible();
 await page.getByTestId('layout-slot-0').click({position:{x:50,y:50}});
 await page.getByRole('button',{name:'作画',exact:true}).click();
 await expect(page.getByRole('button',{name:/このコマの再生成候補を作る/})).toBeVisible();
 await page.getByRole('button',{name:'仕上げ',exact:true}).click();
 await expect(page.getByRole('region',{name:'セクションの完了管理'})).toBeVisible();
 await page.getByRole('button',{name:'接続・人物設定'}).click();
 await page.getByLabel('画像生成モデル',{exact:true}).selectOption('runway-gen4-image');
 await expect(page.getByRole('button',{name:'画像モデルを準備する'})).toHaveCount(0);
 await expect(page.getByRole('group',{name:'Runway静止画の接続'})).toBeVisible();
 expect(await page.evaluate(async()=>{const {loadProject}=await import('/src/bridge.js');return (await loadProject()).mediaDefaults.image;})).toBe('runway-gen4-image');
});

// Native IPC fixture: registration is local; no actual provider request or key.
test('OpenAI and Runway manual keys remain outside saved projects and model switches', async ({page}) => {
  await page.addInitScript(legacy => {
    const connections = new Map();
    window.__TAURI_INTERNALS__ = {invoke: async (command, args) => {
      if (command === 'acceptance_context') return null;
      if (command === 'source_library') return {active:'primary',entries:[{id:'primary',name:'Fixture',repo:'example/story',episode:'P01'}]};
      if (command === 'load_project') return sessionStorage.getItem('fixture-project') || JSON.stringify(legacy);
      if (command === 'save_project') { sessionStorage.setItem('fixture-project', args.data); return; }
      if (command === 'register_image') {
        if (args.input.credential !== 'fixture-key-do-not-persist' || !args.input.approved) throw Error('Invalid registration');
        connections.set(args.modelId, true); return args.modelId;
      }
      if (command === 'media_connection_registered') return connections.has(args.connectionId) && args.connectionId === args.modelId;
      if (command === 'remove_image') { connections.delete(args.connectionId); return; }
      throw Error(`Unexpected IPC, including a connection probe: ${command}`);
    }};
  }, legacy);
  await page.goto('/');
  await page.getByRole('button',{name:'接続・人物設定'}).click();
  await expect(page.getByText(/TapNow/)).toHaveCount(0);
  for (const id of ['openai-gpt-image-2-5','runway-gen4-image']) {
    await page.getByLabel('画像生成モデル',{exact:true}).selectOption(id);
    await expect(page.getByRole('button',{name:'画像モデルを準備する'})).toHaveCount(0);
    await page.getByLabel('静止画APIキー',{exact:true}).fill('fixture-key-do-not-persist');
    await page.getByRole('checkbox',{name:/選択コマの作画指示と対応画像を/}).check();
    await page.getByRole('button',{name:'静止画接続を登録',exact:true}).click();
    await expect(page.getByText('キーを登録済み',{exact:true})).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('fixture-project'))).not.toContain('fixture-key-do-not-persist');
  }
  await page.getByLabel('画像生成モデル',{exact:true}).selectOption('openai-gpt-image-2-5');
  await expect(page.getByText('キーを登録済み',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'静止画接続を解除',exact:true}).click();
  await expect(page.getByLabel('静止画APIキー',{exact:true})).toHaveValue('');
});
