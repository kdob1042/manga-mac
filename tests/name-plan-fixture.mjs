import { FORMAT, POLICY_VERSION } from '../contracts/name-plan/schema.mjs';
import { atomize, sourceDescriptor } from '../contracts/name-plan/source.mjs';
export const leaf = panelId => ({ type: 'leaf', panelId });
export const split = (type, children, weights = children.map(() => 1), slant = 0) => ({ type, children, weights, ...(slant ? { slant } : {}) });
export function fixture(count = 6, text = null) {
  const snapshot = { id: 'snap', repo: 'fixture/stories', workId: 'example', sha: 'a'.repeat(40), sync: { source_branch: 'dev' }, settings: [], scenes: [{ id: 'S01', episodeId: 'P01', text: text ?? '# Scene\n\n' + Array.from({ length: count }, (_, i) => `描写${i + 1}。`).join('\n\n') }] };
  const project = { version: 5, workId: 'example', active: 'snap', snapshots: [snapshot], characters: [], panels: [], jobs: [], artworks: [], history: [], sourceApplication: { version: 1, units: [] }, layout: { version: 1, pages: [], knownPanelIds: [] } };
  const atoms = atomize(snapshot);
  const plan = {
    workGoal: { readerQuestion: '相手はどう応えるか', emotionalArc: ['期待', '反応'], payoff: '違いに気づく' },
    coverage: atoms.map(atom => ({ atomId: atom.id, presentation: atom.kind === 'dialogue' ? 'dialogue' : atom.kind === 'reference' ? 'reference' : 'visual', reason: '原文の意味を保持する' })),
    beats: [{ id: 'b1', atomIds: atoms.map(atom => atom.id), function: 'setup', tempo: 'normal', readerBefore: '場所を知らない', readerAfter: '場所が分かる' }],
    panels: atoms.map((atom, i) => ({ id: `p${i + 1}`, atomIds: [atom.id], contextAtomIds: [], beatIds: ['b1'], characterIds: [], role: 'standard', shot: 'medium', shotIntent: '原稿の場面を描く', prompt: 'No text. Follow the source scene.', silentReason: '', protect: ['中心の人物'], gaze: 'neutral' })),
    pages: [],
  };
  for (let i = 0; i < plan.panels.length; i += 6) {
    const ps = plan.panels.slice(i, i + 6);
    const rows = [];
    for (let j = 0; j < ps.length; j += 2) { const leaves = ps.slice(j, j + 2).map(p => leaf(p.id)); rows.push(leaves.length === 1 ? leaves[0] : split('row', leaves)); }
    plan.pages.push({ id: `page${plan.pages.length + 1}`, purpose: '位置と反応を伝える', entryBeatId: 'b1', exit: { kind: 'pause', note: '静かに次へ', payoffBeatIds: [] }, tree: rows.length === 1 ? rows[0] : split('column', rows) });
  }
  return { project, snapshot, atoms, plan };
}
export async function fileFixture(count = 6, text = null) {
  const f = fixture(count, text);
  return { ...f, file: { format: FORMAT, title: '人工ネーム', readingDirection: 'rtl', stage: 'name-only', source: await sourceDescriptor(f.project, f.snapshot, f.atoms), policyVersion: POLICY_VERSION, provenance: { producer: 'fixture', model: '', editedBy: [] }, plan: f.plan } };
}
