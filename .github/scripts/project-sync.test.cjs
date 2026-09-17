const { test } = require('node:test');
const assert = require('node:assert/strict');
const { references, followUpReferences, related, statusFor, completionCandidate, failingRuns, changesRequested, reconcile, start } = require('./project-sync.cjs');
const fullName = 'kdob1042/manga-mac';
const issue = { number: 10, node_id: 'I10', state: 'open', labels: [] };
const pull = { number: 13, state: 'open', body: 'Refs #10', head: { ref: 'issue/10-work', sha: 'new', repo: { full_name: fullName } }, base: { ref: 'dev' } };
test('explicit local references only; completion wins over Refs', () => {
  assert.deepEqual([...references('Refs #10\nCloses #10\n- Fixes kdob1042/manga-mac#11', fullName)], [[10, true], [11, true]]);
  for (const body of ['Closes other/repo#10', 'Example: Closes #10', '`Closes #10`', '```\nCloses #10\n```', '<!--\nCloses #10\n-->']) {
    assert.equal(references(body, fullName).size, 0, body);
  }
  assert.equal(related(pull, 10, fullName), true);
  assert.equal(related({ ...pull, head: { ...pull.head, repo: { full_name: 'fork/manga-mac' } } }, 10, fullName), false);
});
test('partial work requires an explicit follow-up Issue marker', () => {
  assert.deepEqual([...followUpReferences('Parent: #10', fullName)], [10]);
  assert.deepEqual([...followUpReferences('Continues: kdob1042/manga-mac#10', fullName)], [10]);
  assert.equal(followUpReferences('Parent: other/repo#10', fullName).size, 0);
  const partial = { ...pull, state: 'closed', body: 'Refs #10', merged_at: '2026-09-18T00:00:00Z' };
  assert.equal(completionCandidate(issue, [partial], fullName), null);
  assert.equal(completionCandidate(issue, [partial], fullName, true), partial);
});
test('state is derived from actual issue and open PRs, not status labels', () => {
  assert.equal(statusFor(issue, [], new Map()), 'Todo');
  assert.equal(statusFor(issue, [pull], new Map()), 'In Progress');
  assert.equal(statusFor(issue, [pull], new Map([[13, true]])), 'Needs attention');
  assert.equal(statusFor({ ...issue, state: 'closed' }, [pull], new Map([[13, true]])), 'Done');
  assert.equal(statusFor(issue, [{ ...pull, state: 'closed' }], new Map()), 'Needs attention');
  assert.equal(statusFor({ ...issue, labels: ['agent:start'] }, [], new Map()), 'Needs attention');
});
test('only explicit complete merge or migrated follow-up closes; historical and multiple PR cases stay open', () => {
  const merged = { ...pull, state: 'closed', body: 'Closes #10', merged_at: '2026-09-18T00:00:00Z' };
  assert.equal(completionCandidate(issue, [merged], fullName), merged);
  const partial = { ...merged, body: 'Refs #10' };
  assert.equal(completionCandidate(issue, [partial], fullName), null);
  assert.equal(completionCandidate(issue, [partial], fullName, true), partial);
  for (const candidate of [{ ...merged, merged_at: null }, { ...merged, merged_at: '2026-09-16T00:00:00Z' }, { ...merged, base: { ref: 'feature' } }]) {
    assert.equal(completionCandidate(issue, [candidate], fullName), null);
  }
  assert.equal(completionCandidate(issue, [merged, pull], fullName), null);
});
test('CI recovery uses latest run/attempt and current head, ignores unrelated workflows', () => {
  const bad = { id: 1, workflow_id: 5, run_attempt: 1, head_sha: 'new', name: 'CI', status: 'completed', conclusion: 'failure' };
  assert.equal(failingRuns([bad], 'new', 'CI'), true);
  assert.equal(failingRuns([bad], 'different', 'CI'), false);
  assert.equal(failingRuns([bad], 'new', 'other'), false);
  assert.equal(failingRuns([bad, { ...bad, id: 2, conclusion: 'success' }], 'new', 'CI'), false);
  assert.equal(failingRuns([{ ...bad, run_attempt: 2, conclusion: 'success' }, bad], 'new', 'CI'), false);
  assert.equal(failingRuns([bad, { ...bad, id: 2, status: 'in_progress', conclusion: null }], 'new', 'CI'), false);
  assert.equal(failingRuns([undefined, bad], 'new', 'CI'), true);
  assert.equal(failingRuns(undefined, 'new', 'CI'), false);
});
test('review approval or dismissal clears attention, comments do not', () => {
  const review = { id: 1, user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' };
  assert.equal(changesRequested([review]), true);
  assert.equal(changesRequested([review, { ...review, id: 2, state: 'COMMENTED' }]), true);
  assert.equal(changesRequested([review, { ...review, id: 2, state: 'APPROVED' }]), false);
  assert.equal(changesRequested([review, { ...review, id: 2, state: 'DISMISSED' }]), false);
});

function fixture({ status = 'Todo', prs = [], state = 'open', events = [], access = true, archived = false, labels = [], exists = true } = {}) {
  const writes = [];
  const current = { ...issue, state, labels };
  const item = { id: 'item', isArchived: archived, content: { __typename: 'Issue', id: 'I10', number: 10, repository: { nameWithOwner: fullName } }, fieldValueByName: { name: status } };
  const opts = ['Todo', 'In Progress', 'Needs attention', 'Done'].map(name => ({ name, id: name }));
  const github = { rest: { issues: {}, pulls: {}, actions: {} }, paginate: async (method) => method(), graphql: async (query, variables) => {
    if (query.includes('viewerCanUpdate')) return { user: { projectV2: { id: 'project', viewerCanUpdate: access, fields: { nodes: [{ id: 'field', name: 'Status', options: opts }] } } } };
    if (query.includes('items(first')) return { node: { items: { nodes: exists ? [item] : [], pageInfo: { hasNextPage: false } } } };
    writes.push({ query, variables });
    if (query.includes('addProject')) return { addProjectV2ItemById: { item: { id: 'item' } } };
    item.fieldValueByName.name = variables.option;
    return {};
  } };
  github.rest.issues.listForRepo = async () => state === 'open' ? [current] : [];
  github.rest.issues.get = async () => ({ data: current });
  github.rest.issues.listEventsForTimeline = async () => events;
  github.rest.issues.update = async args => { writes.push(args); current.state = args.state; };
  github.rest.issues.removeLabel = async args => { writes.push(args); };
  github.rest.pulls.list = async () => prs;
  github.rest.pulls.listReviews = async () => [];
  github.rest.actions.listWorkflowRunsForRepo = async () => [];
  const context = { repo: { owner: 'kdob1042', repo: 'manga-mac' } };
  return { github, context, core: { info() {} }, writes, current };
}
test('reconcile is idempotent and new issues are auto-added', async () => {
  const f = fixture({ prs: [pull] });
  await reconcile(f);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].variables.option, 'In Progress');
  await reconcile(f);
  assert.equal(f.writes.length, 1);
  const fresh = fixture({ exists: false });
  await reconcile(fresh);
  assert.equal(fresh.writes.length, 2);
  assert.equal(fresh.writes[1].variables.option, 'Todo');
});
test('close updates Done in the same execution; reopened issue is never reclosed', async () => {
  const merged = { ...pull, state: 'closed', merged_at: '2026-09-18T00:00:00Z', body: 'Closes #10' };
  const f = fixture({ prs: [merged] });
  await reconcile(f);
  assert.equal(f.current.state, 'closed');
  assert.equal(f.writes.at(-1).variables.option, 'Done');
  const reopened = fixture({ prs: [merged], events: [{ event: 'reopened', created_at: '2026-09-19T00:00:00Z' }] });
  await reconcile(reopened);
  assert.equal(reopened.current.state, 'open');
  assert.equal(reopened.writes.at(-1).variables.option, 'Needs attention');
});
test('dry run writes nothing; revoked credentials fail; archived cards are preserved', async () => {
  const f = fixture({ prs: [pull], labels: ['status:ready'] });
  await reconcile({ ...f, dryRun: true });
  assert.equal(f.writes.length, 0);
  await assert.rejects(reconcile(fixture({ access: false })), /PROJECTS_TOKEN/);
  const archived = fixture({ archived: true, prs: [pull] });
  await reconcile(archived);
  assert.equal(archived.writes.length, 0);
});
test('obsolete state labels are removed individually only after sync', async () => {
  const f = fixture({ labels: ['bug', 'status:ready', 'agent:started'] });
  await reconcile(f);
  assert.deepEqual(f.writes.map(w => w.name), ['status:ready', 'agent:started']);
});
test('start rejects unauthorized actors before any mutation', async () => {
  const f = fixture();
  f.context.actor = 'outsider';
  f.context.payload = { issue: { number: 10 } };
  f.github.rest.repos = { getCollaboratorPermissionLevel: async () => ({ data: { permission: 'read' } }) };
  await assert.rejects(start(f), /write permission/);
  assert.equal(f.writes.length, 0);
});
