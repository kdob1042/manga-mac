import { test, expect } from '@playwright/test';
test('backup setup is opt-in, secrets clear, and restore does not open or overwrite the current work', async ({ page }) => {
  await page.addInitScript(() => {
    let config = null; let restored = [];
    window.calls = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command,args) => {
      // Record command shape only: tests do not persist password payloads/screenshots.
      window.calls.push(command);
      if (command === 'load_project') return null;
      if (command === 'backup_status') return { config, status: { phase: '', last_success: 0, last_verified: 0 }, changed: true, next_backup: 0, restored, active: 'primary' };
      if (command === 'backup_setup') { config = { repository: args.input.repository, enabled: true }; return; }
      if (command === 'backup_run') return;
      if (command === 'backup_history') return [{ id: 'a'.repeat(64), series: 'fixture-series', completed_at: 1700000000 }];
      if (command === 'backup_restore') { restored = [{ id: 'restored-fixture', origin: { created_at: 1700000000 } }]; return 'restored-fixture'; }
      throw Error('Unexpected command');
    } };
  });
  await page.goto('/'); await page.getByRole('button',{name:'接続・人物設定'}).click();
  await expect(page.getByRole('button',{name:'今すぐバックアップ'})).toBeDisabled();
  await page.getByText('保存先を設定・再接続',{exact:true}).click();
  const connect = page.getByRole('button',{name:'接続を検査して有効にする'});
  await expect(connect).toBeDisabled();
  await page.getByLabel('restic実行ファイルの絶対パス').fill('/approved/restic');
  await page.getByLabel('rclone実行ファイルの絶対パス').fill('/approved/rclone');
  await page.getByLabel('専用rclone設定ファイルの絶対パス').fill('/approved/rclone.conf');
  await page.getByLabel('復元用パスワード',{exact:true}).fill('artificial-password');
  await page.getByLabel('公式配布物のSHA-256を導入手順で照合した').check();
  await page.getByLabel('復元用パスワードをMac以外にも保管した').check();
  await expect(connect).toBeDisabled();
  await page.getByLabel('表示された作品データの送信・週次保存・21日後の旧版削除を有効にする').check();
  await connect.click(); await expect(page.getByLabel('復元用パスワード',{exact:true})).toHaveValue('');
  await expect(page.getByRole('button',{name:'今すぐバックアップ'})).toBeEnabled();
  await page.getByRole('button',{name:'履歴を取得'}).click();
  await page.getByRole('button',{name:'別作品として復元',exact:true}).click();
  await expect(page.getByRole('button',{name:'この復元作品を開く'})).toBeVisible();
  const calls = await page.evaluate(() => window.calls);
  expect(calls).toContain('backup_restore'); expect(calls).not.toContain('backup_open'); expect(calls).not.toContain('save_project');
  await page.getByText('保存先を設定・再接続',{exact:true}).click();
  await page.locator('.backup-settings').screenshot({path:'test-results/backup-settings.png'});
});
