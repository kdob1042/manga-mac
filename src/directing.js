
// Existing project revisions may still contain abandoned direction runs.
export function activeDirection(project, panelId) {
  return (project.directing_runs ?? []).findLast(r => r.panel_id === panelId && !['complete','abandoned'].includes(r.status));
}
export function abandonDirection(project, id) {
  return { ...project, directing_runs: (project.directing_runs ?? []).map(r => r.id === id && r.status !== 'complete' ? { ...r, status: 'abandoned' } : r) };
}
