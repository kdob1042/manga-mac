import { digest, imageHash } from './revisions.js';

// Keep the editable scene and its rendered image independently verifiable. The
// image is externalized by native storage under the existing `original` key.
export async function sceneHash(scene) {
  if (!scene || ![1,2].includes(scene.schemaVersion)) throw Error('撮影する3D構図がありません');
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return digest(new TextEncoder().encode(JSON.stringify(canonical(scene))));
}

export async function recordSceneCapture(project, panelId, png, width, height) {
  const panel = project.panels?.find(p => p.id === panelId);
  if (!panel?.scene3d || ![1,2].includes(panel.scene3d.schemaVersion)) throw Error('撮影するコマの3D構図がありません');
  if (!Array.isArray(panel.scene3d.objects) || panel.scene3d.objects.length === 0) throw Error('撮影する3D素材を配置してください');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 4096 || height > 4096) throw Error('撮影寸法が不正です');
  if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,')) throw Error('撮影PNGがありません');
  const header = Uint8Array.from(atob(png.slice('data:image/png;base64,'.length, 'data:image/png;base64,'.length + 48)), c => c.charCodeAt(0));
  if (header.length < 24 || [137, 80, 78, 71, 13, 10, 26, 10].some((byte, i) => header[i] !== byte) ||
      String.fromCharCode(...header.slice(12, 16)) !== 'IHDR' ||
      new DataView(header.buffer).getUint32(16) !== width || new DataView(header.buffer).getUint32(20) !== height) {
    throw Error('撮影PNGの形式または寸法が一致しません');
  }
  const hash = await imageHash(png);
  const currentSceneHash = await sceneHash(panel.scene3d);
  const assets = (panel.scene3d.objects ?? []).map(object => {
    const asset = project.sceneAssets?.find(item => item.id === object.assetId);
    if (!asset?.hash || !/^[0-9a-f]{64}$/.test(asset.hash)) throw Error(`撮影素材が未解決です: ${object.assetId}`);
    return { id: asset.id, hash: asset.hash };
  });
  const id = `capture:three:${crypto.randomUUID()}`;
  const capture = {
    id, panel_id: panelId, source_revision: panel.snapshotId,
    parent_revision: panel.capture_revision ?? null, origin: 'three',
    scene_hash: currentSceneHash, checkpoint: { hash: currentSceneHash },
    assets,
    image: { hash }, original: png, settings: { resolution: [width, height] },
    renderer: 'three-webgl', at: new Date().toISOString(),
  };
  return {
    ...project,
    captures: [...(project.captures ?? []), capture],
    panels: project.panels.map(p => p.id === panelId ? { ...p, capture_revision: id } : p),
    history: [...(project.history ?? []), { panels: project.panels, label: '3D構図を撮影', at: capture.at }],
  };
}

export async function verifySceneCapture(panel, capture) {
  if (capture?.origin !== 'three' || capture.panel_id !== panel.id || capture.id !== panel.capture_revision ||
      capture.source_revision !== panel.snapshotId || capture.scene_hash !== await sceneHash(panel.scene3d) ||
      !capture.original || await imageHash(capture.original) !== capture.image?.hash) {
    throw Error('撮影原本の版または画像が現在の構図と一致しません。構図を撮り直してください');
  }
  return capture.original;
}
