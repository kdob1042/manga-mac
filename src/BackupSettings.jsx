import React, { useEffect, useRef, useState } from 'react';
import { call, desktop } from './bridge';
const date = seconds => seconds ? new Date(seconds * 1000).toLocaleString('ja-JP') : '未実施';
const phases = { preparing: '保存状態を確定中', uploading: '転送・全量復元検証中', verifying: '全量復元検証中', succeeded: '処理完了', failed: '失敗' };
export function useBackupSchedule(ready, busy) {
  const current = useRef({ ready, busy }); current.current = { ready, busy };
  useEffect(() => {
    if (!desktop()) return;
    let running = false, disposed = false;
    const tick = async () => {
      if (disposed || running || !current.current.ready || current.current.busy) return;
      running = true;
      try { await call('backup_run', { automatic: true }); }
      catch { /* Native status persists failure and bounded retry deadline. */ }
      finally { running = false; }
    };
    const timer = setInterval(tick, 60000);
    const visibility = () => { if (!document.hidden) tick(); };
    window.addEventListener('focus', tick); document.addEventListener('visibilitychange', visibility);
    tick();
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', visibility); };
  }, []);
}
export default function BackupSettings({ disabled }) {
  const [data, setData] = useState(null), [pending, setPending] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [history, setHistory] = useState([]);
  const [blender, setBlender] = useState('/Applications/Blender.app/Contents/MacOS/Blender');
  const [form, setForm] = useState({ repository: 'rclone:manga:manga-mac-backups/works', restic: '', rclone: '', rclone_config: '', password: '', consent: false, tools_verified: false, password_saved_elsewhere: false, initialize: false });
  const refresh = async () => setData(await call('backup_status'));
  useEffect(() => {
    if (!desktop()) return;
    let mounted = true;
    const poll = () => call('backup_status').then(value => { if (mounted) setData(value); }).catch(e => { if (mounted) setError(String(e)); });
    poll(); const timer = setInterval(poll, 3000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  const action = async fn => { if (pending) return; setPending(true); setError(''); setMessage(''); try { await fn(); await refresh(); } catch (e) { setError(e.message ?? String(e)); } finally { setPending(false); } };
  const set = (key, value) => setForm(old => ({ ...old, [key]: value }));
  const locked = disabled || pending || !desktop();
  return <div className="backup-settings">
    <h3>05 / クラウドバックアップ</h3>
    <p>週1回＋手動保存。最新の正常版は期限なしで保持し、それ以外は完了から21日後に自動削除します。</p>
    <small>作品DB・原稿・参照画像・候補と履歴・動画・固定済みBlender素材を送信します。未保存のBlender編集、アプリ管理外の書き出し、AIモデル、認証情報は対象外です。</small>
    {!desktop() && <p>クラウドへの接続・保存・復元はMacアプリで利用できます。</p>}
    {data && <dl className="backup-status"><dt>保存先</dt><dd>{data.config?.repository ?? '未設定（自動保存は無効）'}</dd><dt>自動保存</dt><dd>{data.config?.enabled ? '有効' : '無効'}</dd><dt>状態</dt><dd>{phases[data.status.phase] ?? '未実施'}</dd><dt>最終成功</dt><dd>{date(data.status.last_success)}</dd><dt>最終全量検証</dt><dd>{date(data.status.last_verified)}</dd><dt>未保存の変更</dt><dd>{data.changed ? 'バックアップ未確認の変更あり' : '保存済みの作品版と一致'}</dd><dt>次回週次保存</dt><dd>{data.next_backup ? date(data.next_backup) : '設定後、次の実行可能時'}</dd><dt>再試行予定</dt><dd>{data.status.next_attempt ? date(data.status.next_attempt) : 'なし'}</dd><dt>旧版整理</dt><dd>{data.status.cleanup || '未実施'}</dd></dl>}
    {data?.status.failure && <p role="alert">{data.status.failure}</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <div className="backup-actions"><button disabled={locked || !data?.config} onClick={() => action(() => call('backup_run', { automatic: false }))}>今すぐバックアップ</button><button disabled={locked || !data?.config} onClick={() => action(async () => setHistory(await call('backup_history')))}>履歴を取得</button><button disabled={locked || !data?.config?.enabled} onClick={() => action(() => call('backup_disable'))}>自動保存を停止</button></div>
    <small>アプリ終了・オフライン中は実行せず、次の起動・接続後に繰り越します。整理対象はクラウドの旧版だけです。クラウド側のゴミ箱により請求容量の反映が遅れる場合があります。</small>
    {history.length > 0 && <ul>{[...history].sort((a,b) => b.completed_at-a.completed_at).map(s => <li key={s.id}>{date(s.completed_at)} · 作品 {s.series.slice(0,8)} <button disabled={locked} onClick={() => action(async () => { await call('backup_restore', { snapshotId: s.id }); setMessage('別作品として復元・検証しました。下の一覧から開けます。現在の作品は保持されています。'); })}>別作品として復元</button></li>)}</ul>}
    {(data?.restored.length > 0 || data?.active !== 'primary' && data) && <div><h4>作品を切り替える</h4><small>保存済みの作品を開くためアプリを再起動します。実行中の作画・転送がある場合は切り替えできません。</small><button disabled={locked || data.active === 'primary'} onClick={() => action(() => call('backup_open', { workspace: 'primary' }))}>元の作品を開く</button>{data.restored.map(w => <div key={w.id}>復元 {date(w.origin.created_at)} <button disabled={locked || data.active === w.id} onClick={() => action(() => call('backup_open', { workspace: w.id }))}>この復元作品を開く</button></div>)}</div>}
    {data && data.active !== 'primary' && <div><label>復元作品のBlender実行ファイル<input value={blender} onChange={e => setBlender(e.target.value)}/></label><button disabled={locked} onClick={() => action(async () => { await call('backup_rebind_blender', { binary: blender }); setMessage('保存版を保持してBlender実行ファイルを再設定しました。'); })}>保存版を保持してBlenderを再接続</button></div>}
    <details><summary>保存先を設定・再接続</summary>
      <p>導入ガイドの手順でrestic 0.19.1・rclone 1.75.1を用意し、Google DriveまたはOneDriveの専用remoteを設定してください。</p>
      {[['repository','クラウド保存先'],['restic','restic実行ファイルの絶対パス'],['rclone','rclone実行ファイルの絶対パス'],['rclone_config','専用rclone設定ファイルの絶対パス']].map(([key,label]) => <label key={key}>{label}<input value={form[key]} disabled={locked} onChange={e => set(key,e.target.value)}/></label>)}
      <label>復元用パスワード<input type="password" autoComplete="off" value={form.password} disabled={locked} onChange={e => set('password',e.target.value)}/></label>
      <small>パスワードはMacのKeychainへ保存します。Macを失ったときにも使えるよう、別のパスワード管理先へ保管してください。既存バックアップへの再接続には同じパスワードが必要です。</small>
      {[['initialize','新しい空の保存先を初期化する（再接続では選択しない）'],['tools_verified','公式配布物のSHA-256を導入手順で照合した'],['password_saved_elsewhere','復元用パスワードをMac以外にも保管した'],['consent','表示された作品データの送信・週次保存・21日後の旧版削除を有効にする']].map(([key,label]) => <label className="backup-check" key={key}><input type="checkbox" checked={form[key]} disabled={locked} onChange={e => set(key,e.target.checked)}/>{label}</label>)}
      <button disabled={locked || !form.consent || !form.tools_verified || !form.password_saved_elsewhere || form.password.length < 12} onClick={() => action(async () => { try { await call('backup_setup', { input: form }); setMessage('保存先を接続しました。週次保存を有効にしました。'); } finally { set('password',''); } })}>接続を検査して有効にする</button>
    </details>
  </div>;
}
