import { convertFileSrc } from '@tauri-apps/api/core';
import { call, desktop } from './bridge.js';

const HASH = /^[0-9a-f]{64}$/;
const KINDS = new Set(['character', 'environment', 'prop']);
const SOURCES = new Set(['import', 'tripo']);
const MAX_IMPORT = 64 * 1024 * 1024;

export function sceneAssets(project) {
  if (project.sceneAssets != null && !Array.isArray(project.sceneAssets)) throw Error('3D素材一覧が不正です');
  return project.sceneAssets ?? [];
}

export function registerSceneAsset(project, { name, kind, source, file, hash, bytes, rigStatus = 'unknown' }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || !KINDS.has(kind) || !SOURCES.has(source)
    || !HASH.test(hash ?? '') || file !== `${hash}.glb` || !Number.isSafeInteger(bytes) || bytes < 20 || bytes > 128 * 1024 * 1024
    || !['unknown', 'compatible', 'incompatible'].includes(rigStatus)) throw Error('3D素材の登録情報が不正です');
  const assets = sceneAssets(project);
  const existing = assets.find(asset => asset.id === hash);
  if (existing) {
    if (existing.hash !== hash || existing.file !== file || existing.bytes !== bytes) throw Error('3D素材の登録IDが衝突しました');
    return { project, asset: existing };
  }
  const asset = { id: hash, name: name.trim(), kind, source, file, hash, bytes, rigStatus };
  return { project: { ...project, sceneAssets: [...assets, asset] }, asset };
}

// File is obtained from an explicit OS file picker. Transfer only its bytes;
// accepting an arbitrary absolute path from the webview would expose host files.
export async function importSceneGlb(project, { file, kind = 'prop', name = file?.name?.replace(/\.glb$/i, '') }) {
  if (!desktop()) throw Error('3D素材の取り込みはMacアプリで利用できます');
  if (!file || !/\.glb$/i.test(file.name ?? '') || !file.size || file.size > MAX_IMPORT) throw Error('64MB以下のGLBを選択してください');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let base64 = '';
  for (let i = 0; i < bytes.length; i += 0x6000) {
    base64 += btoa(String.fromCharCode(...bytes.subarray(i, i + 0x6000)));
  }
  const artifact = await call('scene_asset_import', { data: base64 });
  return registerSceneAsset(project, { ...artifact, name, kind, source: 'import' });
}

export async function resolveSceneAsset(asset) {
  if (!desktop()) throw Error('3D素材の読み込みはMacアプリで利用できます');
  if (!asset || asset.file !== `${asset.hash}.glb` || !HASH.test(asset.hash ?? '') || !Number.isSafeInteger(asset.bytes)) throw Error('3D素材の参照が不正です');
  const path = await call('scene_asset_url', { file: asset.file, hash: asset.hash, bytes: asset.bytes });
  return convertFileSrc(path);
}
