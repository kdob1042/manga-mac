import React from 'react';
import { providers, defaultConnection, askLLM, registerConnection, releaseConnection } from './llm';

export default function LLMSettings({ title, value, onChange, vision, disabled, run, notify, t }) {
  const external = value.provider !== 'ollama';
  const providerLabel = id => id === 'ollama' ? t('providerOllama') : id === 'custom' ? t('providerCustom') : providers[id].label;
  const replace = next => { onChange(next); releaseConnection(value.connectionId).catch(() => notify(t('oldConnectionReleaseFailed'))); };
  const change = patch => replace({ ...value, ...patch, connectionId: '' });
  return <fieldset disabled={disabled} className="llm-settings"><legend>{title}</legend>
    <label>{t('connectionTarget')}<select aria-label={t('fieldLabel', { title, field: t('connectionTarget') })} value={value.provider} onChange={e => replace(defaultConnection(e.target.value, vision))}>{Object.keys(providers).map(id => <option key={id} value={id}>{providerLabel(id)}</option>)}</select></label>
    {value.provider === 'custom' && <label>{t('customBaseUrl')}<input value={value.baseUrl} onChange={e => change({ baseUrl: e.target.value, apiKey: '' })} placeholder="https://example.com/v1"/></label>}
    <label>{t('modelId')}<input aria-label={t('fieldLabel', { title, field: t('modelId') })} value={value.model} onChange={e => change({ model: e.target.value })} placeholder={vision ? t('visionModelPlaceholder') : t('modelPlaceholder')}/></label>
    {external && <><label>{t('apiKey')}<input type="password" autoComplete="off" aria-label={t('fieldLabel', { title, field: t('apiKey') })} value={value.apiKey} onChange={e => change({ apiKey: e.target.value })}/></label><small>{t('destination', { destination: value.provider === 'custom' ? value.baseUrl || t('unset') : providers[value.provider].baseUrl })}<br/>{vision ? t('visionDisclosure') : t('planningDisclosure')} {t('apiCost')}</small>{value.provider === 'custom' && <label><input type="checkbox" checked={value.jsonMode} onChange={e => change({ jsonMode: e.target.checked })}/> {t('jsonMode')}</label>}</>}
    {!external && <small>{t('ollamaDisclosure')}</small>}
    {value.connectionId && <small>{t('connectionRegistered')}</small>}
    {vision && <small>{t('visionHint')}</small>}
    <button type="button" onClick={() => run(t('runConnectionTest'), async () => { const registered = value.connectionId ? value : await registerConnection(value); onChange(registered); const result = JSON.parse(await askLLM(registered, { purpose: 'probe', prompt: 'Return {"ok":true}.', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })); if (result.ok !== true) throw Error(t('connectionInvalid')); notify(t('connectionSuccess')); })}>{t('testConnection')}</button>
  </fieldset>;
}
