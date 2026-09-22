import { useEffect, useRef } from 'react';
import { call, desktop } from './bridge';

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
