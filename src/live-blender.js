// Credentials stay in the native connection; never in a project or model prompt.
export const liveWork = project => JSON.stringify([project.workId ?? '', project.snapshots?.find(s => s.id === project.active)?.repo ?? '', project.active]);
export const liveCall = (call, project, action, input = {}) => call('blender_live', { action, input: { ...input, work: liveWork(project) } });
