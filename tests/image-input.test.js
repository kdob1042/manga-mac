import test from 'node:test';
import assert from 'node:assert/strict';
import { generationSize, containRect, imageRequest } from '../src/image-input.js';
import { editRoute } from '../src/edit-route.js';
import { migrateProject, beginJob, finishJob, adoptCandidate, abandonJob } from '../src/revisions.js';
import { readFileSync } from 'node:fs';
const legacy = JSON.parse(readFileSync(new URL('./fixtures/legacy-v1.json', import.meta.url)));
test('capture input preserves image bytes, hash, references and revision provenance', () => {
 const original = 'data:image/png;base64,aGVsbG8=', hash = 'a'.repeat(64);
 const references = [{ id: 'actor', name: 'Actor', image: original, hash }];
 const request = imageRequest({ panel: { prompt: 'scene' }, references, original, originalHash: hash, width: 768, height: 512, seed: 5, instruction: 'preserve expression', capture: { id: 'capture:1', image: { hash }, checkpoint: { hash } } });
 assert.equal(request.original, original); assert.equal(request.original_hash, hash);
 assert.equal(request.references[0].image, original); assert.equal(request.capture.id, 'capture:1');
 assert.deepEqual([request.width, request.height], [768,512]);
 assert.throws(() => imageRequest({ panel: {}, references, original }));
});
test('dimensions and page fitting preserve aspect using padding rather than distortion', () => {
 assert.deepEqual(generationSize([1536,1024]), [1024,704]);
 const fit = containRect(1536, 1024, 1024, 704);
 assert.equal(fit.width / fit.height, 1.5); assert.ok(fit.y > 0);
 assert.deepEqual(containRect(768,512,716,716), { x: 0, y: (716-512*716/768)/2, width: 716, height: 512*716/768, scale: 716/768 });
 assert.throws(() => generationSize([4096,64]));
});
test('known camera/layout commands cannot silently become image edits', () => {
 assert.deepEqual(editRoute('カメラを少し寄って'), { kind: 'camera', factor: 1.2 });
 assert.deepEqual(editRoute('焦点距離を80mmに'), { kind: 'camera', lens: 80 });
 assert.equal(editRoute('二人を近づける').kind, 'scene');
 assert.equal(editRoute('吹き出しを移動').kind, 'layout');
 assert.equal(editRoute('口元だけ笑わせて').kind, 'region');
});
test('retake remains candidate until explicit adoption, Undo preserves prior art, stale candidate rejected', async () => {
 const p = await migrateProject(legacy), job = await beginJob(p, p.panels[0], 'retake');
 const running = { ...p, jobs: [job] };
 const result = await finishJob(running, job, { ...p.panels[0], instructions: ['new'] }, false, true);
 assert.deepEqual(result.panels, p.panels); assert.equal(result.jobs[0].status, 'candidate');
 const adopted = await adoptCandidate(result, job.id);
 assert.equal(adopted.panels[0].artwork_revision, `artwork:${job.id}`);
 assert.deepEqual(adopted.history.at(-1).panels, p.panels);
 await assert.rejects(adoptCandidate(adopted, job.id));
 await assert.rejects(adoptCandidate({ ...result, active: 'new' }, job.id));
 await assert.rejects(adoptCandidate({ ...result, style_references: [{ id: 'new-style' }] }, job.id));
});
test('restarts and abandonment do not reset the three-attempt limit', async () => {
 let p = await migrateProject(legacy);
 for (let i=0; i<3; i++) {
  const job = await beginJob(p,p.panels[0],'retake');
  p = await migrateProject({ ...p, jobs:[...p.jobs,job] }, true);
  p = abandonJob(p,job.id);
 }
 await assert.rejects(beginJob(p,p.panels[0],'retake'));
 assert.equal(p.jobs.filter(j => j.kind === 'retake').length, 3);
});
