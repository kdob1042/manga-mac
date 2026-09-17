import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contractLabel,
  mergeSourceReferences,
  referenceDeclarations,
  resolveRepositoryPath,
  sourceContract,
  validateSourceContract,
} from '../src/source-contract.js';

test('Kamiya-Kawai schema 4 contract records the independently verified source commit', () => {
  const contract = sourceContract('KDOB1042/kamiya-kawai');
  assert.equal(contract.aligned_source_commit, '7eed2120eb93e2964cd188b5890f0247c83de540');
  assert.deepEqual(contract.compatible_manifest_schema_versions, [4]);
  assert.equal(validateSourceContract('kdob1042/Kamiya-Kawai', { schema_version: 4, settings: [{ id: 'VISUAL' }] }), contract);
  assert.throws(() => validateSourceContract('kdob1042/Kamiya-Kawai', { schema_version: 5, settings: [{ id: 'VISUAL' }] }), /未対応/);
  assert.throws(() => validateSourceContract('owner/unknown', { schema_version: 4, settings: [] }), /ありません/);
});

test('VISUAL markdown declares repository-contained character references', () => {
  const contract = sourceContract('kdob1042/Kamiya-Kawai');
  const setting = {
    id: 'VISUAL',
    path: 'design/character-design.md',
    text: [
      '![河合由美子のキャラクター基準画](../assets/illustrations/character-reference-yumi.jpg)',
      '![神谷勇のキャラクター基準画](../assets/illustrations/character-reference-yu.jpg)',
    ].join('\n'),
  };
  assert.deepEqual(referenceDeclarations(setting, contract).map(({ name, path }) => ({ name, path })), [
    { name: '河合由美子', path: 'assets/illustrations/character-reference-yumi.jpg' },
    { name: '神谷勇', path: 'assets/illustrations/character-reference-yu.jpg' },
  ]);
  assert.equal(resolveRepositoryPath(setting.path, '../assets/illustrations/a.png'), 'assets/illustrations/a.png');
  assert.throws(() => resolveRepositoryPath('design/a.md', '../../secret.png'), /リポジトリ外/);
});

test('source references are stable, replace a same-name manual reference, and version on image change', () => {
  const manual = [{ id: 'manual-yumi', name: '河合由美子', description: '固定特徴', image: 'old', hash: 'old', version: 2 }];
  const first = mergeSourceReferences(manual, [{ name: '河合由美子', alt: '河合由美子のキャラクター基準画', path: 'assets/illustrations/yumi.jpg', image: 'new', hash: 'h1' }], 'kdob1042/Kamiya-Kawai', 'snapshot-1');
  assert.equal(first.length, 1);
  assert.equal(first[0].id, 'manual-yumi');
  assert.equal(first[0].description, '固定特徴');
  assert.equal(first[0].version, 3);
  assert.equal(first[0].source.snapshot_id, 'snapshot-1');
  const second = mergeSourceReferences(first, [{ name: '河合由美子', alt: '河合由美子のキャラクター基準画', path: 'assets/illustrations/yumi.jpg', image: 'same', hash: 'h1' }], 'kdob1042/Kamiya-Kawai', 'snapshot-2');
  assert.equal(second[0].version, 3);
  assert.equal(second[0].source.snapshot_id, 'snapshot-2');
  assert.equal(contractLabel({ contract: { manifest_schema_version: 4, aligned_source_commit: '7eed2120abcd' } }), '構成schema 4対応 · 確認基準 7eed2120');
});

 test('another registered source uses the same strict schema without inheriting verification provenance',()=>{
 const c=validateSourceContract('owner/second',{schema_version:4,settings:[{id:'VISUAL'}]});
 assert.equal(c.repository,'owner/second');assert.equal(c.aligned_source_commit,'');
 assert.throws(()=>validateSourceContract('owner/second',{schema_version:3,settings:[{id:'VISUAL'}]}),/未対応/);
 assert.equal(contractLabel({contract:{manifest_schema_version:4,aligned_source_commit:''}}),'構成schema 4対応 · 共通構成仕様');
 });
