import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateComparison, panelContext } from '../src/artwork-comparison.js';

function fixture() {
  const base = { id: 'p1', snapshotId: 'source1', artwork_revision: 'base', image: 'base.png' };
  const candidate = { ...base, artwork_revision: 'candidate', image: 'candidate.png' };
  return {
    project: { panels: [base], artworks: [{ id: 'base', panel: base }, { id: 'candidate', panel: candidate }] },
    job: { panelId: 'p1', source_revision: 'source1', base_revision: 'base', output_revision: 'candidate' },
  };
}

test('comparison keeps the saved base after a different candidate or source is adopted', () => {
  const { project, job } = fixture();
  project.panels = [{ ...project.panels[0], artwork_revision: 'newer', snapshotId: 'source2', image: 'newer.png' }];
  const before = JSON.stringify(project);
  const result = candidateComparison(project, job);
  assert.equal(result.base.image, 'base.png');
  assert.equal(result.candidate.image, 'candidate.png');
  assert.equal(result.current.image, 'newer.png');
  assert.equal(result.baseChanged, true);
  assert.equal(result.sourceChanged, true);
  assert.equal(JSON.stringify(project), before);
});

test('missing history only falls back to a panel carrying the exact saved base revision', () => {
  const { project, job } = fixture();
  project.artworks = project.artworks.filter(artwork => artwork.id !== 'base');
  assert.equal(candidateComparison(project, job).base.image, 'base.png');
  const savedPanel = project.panels[0];
  project.panels = [{ ...savedPanel, artwork_revision: 'newer', image: 'newer.png' }];
  assert.equal(candidateComparison(project, job).base, null);
  assert.equal(candidateComparison(project, job).baseMissing, true);
  assert.equal(candidateComparison(project, { ...job, recovery: { panel: savedPanel } }).base.image, 'base.png');
});

test('first generation does not present a later adopted image as its original', () => {
  const { project, job } = fixture();
  const result = candidateComparison(project, { ...job, base_revision: null });
  assert.equal(result.base, null);
  assert.equal(result.baseMissing, false);
  assert.equal(result.baseChanged, true);
  assert.equal(result.current.image, 'base.png');
});

test('revision IDs belonging to a different panel are not used for the comparison', () => {
  const { project, job } = fixture();
  project.panels = [];
  project.artworks = project.artworks.map(artwork => ({ ...artwork, panel: { ...artwork.panel, id: 'another-panel' } }));
  const result = candidateComparison(project, job);
  assert.equal(result.base, null);
  assert.equal(result.candidate, null);
  assert.equal(result.baseMissing, true);
});

test('context follows page reading order across pages and keeps an ungenerated neighbour', () => {
  const project = {
    panels: [
      { id: 'first', sceneId: 'scene1', image: 'first.png', characterIds: ['c2'] },
      { id: 'selected', sceneId: 'scene1', image: 'selected.png', characterIds: ['c1', 'c1', 'missing'] },
      { id: 'last', sceneId: 'scene2', image: null, characterIds: ['c2'] },
    ],
    layout: { pages: [{ slots: [{ panelId: 'first' }, { panelId: 'selected' }] }, { slots: [{ panelId: 'last' }] }] },
    characters: [{ id: 'c1', name: 'Selected character' }, { id: 'c2', name: 'Other character' }],
  };
  // The panel array is not the source of page order.
  project.panels.reverse();
  const result = panelContext(project, 'selected');
  assert.deepEqual(result.rows.map(row => [row.position, row.panel.id, row.pageNumber]), [
    ['previous', 'first', 1], ['current', 'selected', 1], ['next', 'last', 2],
  ]);
  assert.equal(result.rows[2].panel.image, null);
  assert.equal(result.rows[2].differentScene, true);
  assert.deepEqual(result.characters.map(character => character.id), ['c1']);
});

test('unplaced or ambiguous panels never receive invented adjacent panels', () => {
  const { project } = fixture();
  assert.deepEqual(panelContext(project, 'missing'), { rows: [], characters: [] });
  assert.deepEqual(panelContext(project, 'p1').rows.map(row => row.position), ['current']);
  project.layout = { pages: [{ slots: [{ panelId: 'p1' }, { panelId: 'p1' }] }] };
  assert.deepEqual(panelContext(project, 'p1').rows.map(row => row.position), ['current']);
  assert.equal(panelContext(project, 'p1').rows[0].pageNumber, null);
});

test('episode boundaries resolve primary source refs even when scene IDs repeat across snapshots', () => {
  const project = {
    panels: [
      { id: 'previous', snapshotId: 's2', sceneId: 'S01', sourceRefs: [{ snapshotId: 's1', sceneId: 'S01' }] },
      { id: 'selected', snapshotId: 's2', sceneId: 'S01', contextRefs: [{ snapshotId: 's1', sceneId: 'S01' }] },
      { id: 'next', snapshotId: 's1', sceneId: 'S01', sourceRefs: [{ snapshotId: 's2', sceneId: 'S01' }] },
    ],
    snapshots: [
      { id: 's1', episodeId: 'E1', scenes: [{ id: 'S01' }] },
      { id: 's2', episodeId: 'snapshot-fallback', scenes: [{ id: 'S01', episodeId: 'E2' }] },
    ],
    layout: { pages: [{ slots: [{ panelId: 'previous' }, { panelId: 'selected' }, { panelId: 'next' }] }] },
  };
  const rows = panelContext(project, 'selected').rows;
  assert.deepEqual(rows.map(row => row.differentScene), [false, false, false]);
  assert.deepEqual(rows.map(row => row.differentEpisode), [true, false, false]);
  project.panels[0].sourceRefs.push({ snapshotId: 'unknown', sceneId: 'S01' });
  assert.equal(panelContext(project, 'selected').rows[0].differentEpisode, false);
});
