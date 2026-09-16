import React, { useState, useEffect } from 'react';
import { call, desktop } from './bridge';

export default function BlenderSettings({ disabled, run, notify, t }) {
  const [binary, setBinary] = useState('/Applications/Blender.app/Contents/MacOS/Blender');
  const [library, setLibrary] = useState(''), [source, setSource] = useState('');
  const [session, setSession] = useState(null), [lens, setLens] = useState(50);
  useEffect(() => { if (desktop()) call('blender_latest').then(setSession).catch(() => notify(t('blenderLoadFailed'))); }, []);
  const pending = session?.jobs?.some(job => ['unknown', 'running'].includes(job.status));
  const refresh = async () => {
    if (!session) return;
    const current = await call('blender_status', { sessionId: session.session_id });
    setSession(current);
    if (current.state?.state?.lens) setLens(current.state.state.lens);
    return current;
  };
  const recover = (job, action) => run(t('blenderCheckingSave'), async () => {
    const current = await call('blender_recover', {
      sessionId: session.session_id, requestId: job.id,
      expectedRevision: session.revision, action,
    });
    setSession(current);
    if (current.state?.state?.lens) setLens(current.state.state.lens);
    notify(action === 'adopt' ? t('blenderAdopted') : t('blenderAbandoned'));
  });
  const operate = operation => run(t('blenderProcessing'), async () => {
    try {
      const result = await call('blender_execute', { request: { session_id: session.session_id, request_id: crypto.randomUUID(), expected_revision: session.revision, operation } });
      setSession(result); notify(t('blenderVerified'));
    } catch (error) {
      await refresh().catch(() => notify(t('blenderStatusFailed')));
      throw error;
    }
  });
  const jobStatus = job => job.status === 'running' ? t('jobRunning') : job.status === 'candidate' ? t('jobCandidate') : t('jobUnknown');
  return <fieldset disabled={disabled}><legend>Blender 4.5.13</legend>
    <label>{t('blenderExecutable')}<input value={binary} onChange={e => setBinary(e.target.value)}/></label>
    <label>{t('blenderLibrary')}<input value={library} onChange={e => setLibrary(e.target.value)} placeholder={t('blenderLibraryPlaceholder')}/></label>
    <label>{t('blenderSource')}<input value={source} onChange={e => setSource(e.target.value)} placeholder={t('blenderSourcePlaceholder')}/></label>
    <small>{t('blenderSafety')}</small>
    <button onClick={() => run(t('blenderTesting'), async () => {
      const created = await call('blender_register', { input: { binary, library_root: library, source } });
      setSession(created);
      try {
        const result = await call('blender_execute', { request: { session_id: created.session_id, request_id: crypto.randomUUID(), expected_revision: 0, operation: { kind: 'inspect' } } });
        setSession(result); setLens(result.state.state.lens); notify(t('blenderConnectionVerified'));
      } catch (error) {
        await call('blender_status', { sessionId: created.session_id }).then(setSession)
          .catch(() => notify(t('blenderStatusFailed')));
        throw error;
      }
    })}>{t('blenderOpenTest')}</button>
    {session && <>
      <p>{t('blenderRevision', { revision: session.revision, lens: session.state?.state?.lens ?? t('unchecked') })}</p>
      <label>{t('focalLength')}<input type="number" min="10" max="250" value={lens} onChange={e => setLens(Number(e.target.value))}/></label>
      <button disabled={pending} onClick={() => operate({ kind: 'camera', lens })}>{t('changeCamera')}</button>
      <button disabled={pending} onClick={() => operate({ kind: 'capture', width: 768, height: 768 })}>{t('capture')}</button>
      <button onClick={() => run(t('blenderStatusChecking'), async () => {
        const current = await refresh();
        notify(current.jobs.some(j => ['unknown', 'running'].includes(j.status)) ? t('blenderPending') : t('blenderStatusVerified'));
      })}>{t('checkRequestStatus')}</button>
      {session.jobs?.filter(job => ['unknown', 'running', 'candidate'].includes(job.status)).map(job => <div key={job.id}>
        <p>{t('blenderJob', { id: job.id.slice(0, 8), status: jobStatus(job) })}</p>
        <button disabled={job.status === 'running' || job.expected_revision !== session.revision} onClick={() => recover(job, 'adopt')}>{t('adoptSavedResult')}</button>
        <button disabled={job.status === 'running'} onClick={() => recover(job, 'abandon')}>{t('abandonResult')}</button>
      </div>)}
      {session.preview && <img src={session.preview} alt={t('blenderPreviewAlt')} style={{ maxWidth: '100%' }}/>}
    </>}
  </fieldset>;
}
