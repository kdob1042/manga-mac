// Read-only views over the existing artwork history and page order.
// Never substitute a newer adopted image for the candidate's saved base.
export function candidateComparison(project, job) {
  const current = (project.panels ?? []).find(panel => panel.id === job.panelId) ?? null;
  const artwork = (project.artworks ?? []).find(item => item.id === job.output_revision && item.panel?.id === job.panelId);
  const baseRevision = job.base_revision ?? null;
  const savedBase = baseRevision && (project.artworks ?? []).find(item => item.id === baseRevision && item.panel?.id === job.panelId);
  const recovery = job.recovery?.panel;
  const base = savedBase?.panel ?? (baseRevision && recovery?.id === job.panelId && recovery.artwork_revision === baseRevision && recovery.image ? recovery : null)
    ?? (baseRevision && current?.artwork_revision === baseRevision ? current : null);
  return {
    base,
    candidate: artwork?.panel ?? null,
    current,
    baseMissing: Boolean(baseRevision && !base?.image),
    baseChanged: Boolean(current && (current.artwork_revision ?? null) !== baseRevision),
    sourceChanged: Boolean(current && current.snapshotId !== job.source_revision),
  };
}

function episodeSet(panel, snapshots) {
  const refs = panel.sourceRefs?.length ? panel.sourceRefs : [{ snapshotId: panel.snapshotId, sceneId: panel.sceneId }];
  const episodes = refs.map(ref => {
    const snapshot = snapshots.get(ref.snapshotId);
    return snapshot?.scenes?.find(scene => scene.id === ref.sceneId)?.episodeId ?? snapshot?.episodeId;
  });
  // A partial set cannot establish whether two panels belong to different episodes.
  if (episodes.some(id => typeof id !== 'string' || !id.trim())) return null;
  return JSON.stringify([...new Set(episodes)].sort());
}

export function panelContext(project, panelId) {
  const byId = new Map((project.panels ?? []).map(panel => [panel.id, panel]));
  const selected = byId.get(panelId);
  if (!selected) return { rows: [], characters: [] };
  const ordered = (project.layout?.pages ?? []).flatMap((page, pageIndex) =>
    (page.slots ?? []).flatMap((slot, slotIndex) => {
      const panel = byId.get(slot.panelId);
      return panel ? [{ panel, pageNumber: pageIndex + 1, panelNumber: slotIndex + 1 }] : [];
    }));
  const positions = ordered.flatMap((row, index) => row.panel.id === panelId ? [index] : []);
  const index = positions.length === 1 ? positions[0] : -1;
  const snapshots = new Map((project.snapshots ?? []).map(snapshot => [snapshot.id, snapshot]));
  const selectedEpisodes = episodeSet(selected, snapshots);
  const rows = index < 0
    ? [{ panel: selected, position: 'current', pageNumber: null, panelNumber: null, differentScene: false, differentEpisode: false }]
    : [-1, 0, 1].flatMap(offset => {
      const row = ordered[index + offset];
      if (!row) return [];
      const episodes = episodeSet(row.panel, snapshots);
      return [{ ...row, position: offset < 0 ? 'previous' : offset > 0 ? 'next' : 'current', differentScene: row.panel.sceneId !== selected.sceneId,
        differentEpisode: selectedEpisodes !== null && episodes !== null && selectedEpisodes !== episodes }];
    });
  const charactersById = new Map((project.characters ?? []).map(character => [character.id, character]));
  const characters = [...new Set(selected.characterIds ?? [])].map(id => charactersById.get(id)).filter(Boolean);
  return { rows, characters };
}
