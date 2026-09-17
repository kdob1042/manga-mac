import {validate} from './validate.mjs';
export const PREVIEW_VERSION = '1.0.0';
const fail = message => { throw Error(`Live preview: ${message}`); };
function object(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value,key)) || Object.keys(value).some(key => !required.includes(key))) fail('unknown or missing fields');
}
export const tagKey = value => value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
export function validateTags(tags) {
  if (!Array.isArray(tags) || tags.length > 64 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || [...tag].length > 80 || /[\u0000-\u001f\u007f]/.test(tag))) fail('invalid scene tags');
  return tags;
}
export function validatePreview(preview) {
  object(preview,['format','schemaVersion','savedAt','manifest','scenes','panels']);
  if(preview.format !== 'live-manga-preview' || preview.schemaVersion !== PREVIEW_VERSION) fail('unsupported schema');
  if(typeof preview.savedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(preview.savedAt) || (!Number.isFinite(Date.parse(preview.savedAt)) || new Date(preview.savedAt).toISOString()!==preview.savedAt)) fail('invalid saved time');
  validate(preview.manifest);
  if(!Array.isArray(preview.scenes) || preview.scenes.length > 3200 || !Array.isArray(preview.panels) || preview.panels.length > 3200) fail('invalid metadata collections');
  const scenes = new Set();
  for(const scene of preview.scenes) {
    object(scene,['id','tags']);
    if(typeof scene.id !== 'string' || !scene.id.trim() || [...scene.id].length > 256 || /[\u0000-\u001f\u007f<>]/.test(scene.id) || scenes.has(scene.id)) fail('invalid or duplicate scene');
    scenes.add(scene.id);validateTags(scene.tags);
  }
  const panels=new Map(preview.manifest.pages.flatMap(page => page.panels).map(panel => [panel.id,panel])), seen=new Set(), usedScenes=new Set();
  for(const row of preview.panels) {
    object(row,['id','sceneIds','art','lettering','motion']);
    if(!panels.has(row.id) || seen.has(row.id) || !Array.isArray(row.sceneIds) || row.sceneIds.length > 64 || new Set(row.sceneIds).size !== row.sceneIds.length || row.sceneIds.some(id => !scenes.has(id))) fail('invalid panel scene references');
    if(!['ready','pending'].includes(row.art) || !['ready','pending','none'].includes(row.lettering) || !['ready','pending','stale','none'].includes(row.motion)) fail('invalid production status');
    const panel=panels.get(row.id);
    if(Boolean(panel.motion) !== (row.motion==='ready') || (row.art==='pending' && panel.motion)) fail('motion status differs from manifest');
    if(row.lettering==='none' && panel.text!=='') fail('text on textless panel');
    seen.add(row.id);row.sceneIds.forEach(id=>usedScenes.add(id));
  }
  if(seen.size!==panels.size || usedScenes.size!==scenes.size) fail('incomplete or unrelated metadata');
  return preview;
}
export function previewTags(preview) {
  const tags=new Map();
  for(const scene of preview.scenes) for(const tag of scene.tags) if(!tags.has(tagKey(tag))) tags.set(tagKey(tag),tag.trim());
  return [...tags.values()];
}
export function previewMatches(preview, selected = [], mode = 'any') {
  if(!['any','all'].includes(mode)) fail('invalid tag match mode');
  const matches=new Set(preview.scenes.filter(scene=> {
    const keys=new Set(scene.tags.map(tagKey));
    return !selected.length || (mode==='all' ? selected.every(tag=>keys.has(tagKey(tag))) : selected.some(tag=>keys.has(tagKey(tag))));
  }).map(scene=>scene.id));
  const panels=new Set(preview.panels.filter(row=>row.sceneIds.some(id=>matches.has(id))).map(row=>row.id));
  return {sceneIds:[...matches],panelIds:[...panels],pageIds:preview.manifest.pages.filter(page=>!selected.length || page.panels.some(panel=>panels.has(panel.id))).map(page=>page.id)};
}
