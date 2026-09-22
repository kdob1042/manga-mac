import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileSchema, parseNameFile, validateSchema } from '../contracts/name-plan/schema.mjs';
import { createNameCandidate, adoptNameCandidate } from '../src/name-v2.js';
import { fileFixture } from './name-plan-fixture.mjs';

const nativeSchemaText = await readFile(new URL('../contracts/name-plan/schema.json', import.meta.url), 'utf8');
const nativeSchema = JSON.parse(nativeSchemaText);

test('native save schema is the exact generated JS file contract', () => {
  assert.equal(nativeSchemaText, JSON.stringify(fileSchema, null, 2) + '\n');
});

for (const commit of [undefined, 'c'.repeat(40)]) {
  test(`source provenance ${commit ? 'may differ from retrieval SHA' : 'may be absent'} without weakening source binding`, async () => {
    const { project, file } = await fileFixture(2);
    if (commit === undefined) delete file.source.commit;
    else file.source.commit = commit;
    const before = structuredClone(project);
    validateSchema(file, nativeSchema);
    parseNameFile(JSON.stringify(file));
    const candidate = await createNameCandidate(project, file);
    assert.deepEqual(project, before);
    const adopted = await adoptNameCandidate(project, candidate);
    assert.equal(adopted.namePlan.status, 'adopted');
    assert.equal(adopted.namePlan.file.source.commit, commit);
    assert.equal(adopted.panels.length, 2);
    assert.deepEqual(adopted.sourceApplication.units, []);
    assert.equal(adopted.jobs.some(job => ['generate', 'retake'].includes(job.kind)), false);
    const changed = structuredClone(project);
    changed.snapshots[0].scenes[0].text += '本文変更';
    await assert.rejects(createNameCandidate(changed, file), error => error.code === 'source_changed');
  });
}

for (const commit of ['', 'future-sha', null, 42]) {
  test(`supplied malformed source commit is rejected by both contracts: ${JSON.stringify(commit)}`, async () => {
    const { file } = await fileFixture(1);
    file.source.commit = commit;
    assert.throws(() => parseNameFile(JSON.stringify(file)));
    assert.throws(() => validateSchema(file, nativeSchema));
  });
}
