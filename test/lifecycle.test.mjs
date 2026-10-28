import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createManager } from '../src/manager.mjs';
import { createHarness, ownProfile, assertSecureSsh, filesBelow, FIXTURE_TOKEN, UNRELATED_PROFILE, UNRELATED_SSH } from './fixtures.mjs';

async function context(t) {
  const fixture = await createHarness();
  t.after(() => fixture.close());
  return { fixture, manager: await createManager({ env: fixture.env }) };
}

async function create(manager, name = 'Lifecycle machine') {
  const result = await manager.execute({ kind: 'create', name });
  assert.match(result.id, /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
  return result.id;
}

const cloudWrites = (boat) => boat.requests.filter((request) => ['POST', 'PATCH', 'DELETE'].includes(request.method));

test('create, stop, resume and sync retain one Herdr identity while rotating its trusted SSH endpoint', async (t) => {
  const { fixture, manager } = await context(t);
  const id = await create(manager);
  const initial = ownProfile(await fixture.profiles(), id);
  assert.equal(initial.enabled, true);
  const firstSsh = await assertSecureSsh(fixture, initial);
  await manager.execute({ kind: 'sync', id });
  assert.equal(ownProfile(await fixture.profiles(), id).id, initial.id);
  await manager.execute({ kind: 'stop', id, confirmation: id });
  assert.equal(fixture.boat.sandboxes.get(id).state, 'archived');
  assert.equal(ownProfile(await fixture.profiles(), id).enabled, false);
  await manager.execute({ kind: 'resume', id, size: 'large' });
  const resumed = ownProfile(await fixture.profiles(), id);
  assert.equal(resumed.id, initial.id);
  assert.equal(resumed.enabled, true);
  assert.equal(fixture.boat.sandboxes.get(id).type, 'large');
  const secondSsh = await assertSecureSsh(fixture, resumed, 1);
  assert.notEqual(secondSsh.knownHostsPath, firstSsh.knownHostsPath, 'Host key replacement must use a fresh pin file');
  assert.equal(await readFile(firstSsh.knownHostsPath, 'utf8'), firstSsh.knownHosts, 'Existing sessions retain their immutable host pin');
  await manager.execute({ kind: 'sync' });
  assert.equal(ownProfile(await fixture.profiles(), id).id, initial.id);
  assert.deepEqual((await fixture.profiles()).find((profile) => profile.id === UNRELATED_PROFILE.id), UNRELATED_PROFILE);
  assert.ok((await readFile(join(fixture.home, '.ssh', 'config'), 'utf8')).endsWith(UNRELATED_SSH), 'Existing SSH config bytes must remain intact');
  const unrelated = await fixture.ssh('unrelated');
  assert.equal(unrelated.hostname, '192.0.2.99');
  assert.equal(unrelated.port, '2244');
  assert.equal(unrelated.user, 'original-user');
  const unmatched = await fixture.ssh('not-a-boat-machine');
  assert.equal(unmatched.hostname, 'not-a-boat-machine', 'Included stanzas must not leak to unrelated hosts');
});

test('fork, rename, timer, recover, snapshots, adoption and forget are observable lifecycle operations', async (t) => {
  const { fixture, manager } = await context(t);
  const sourceId = await create(manager, 'Source');
  await manager.execute({ kind: 'stop', id: sourceId, confirmation: sourceId });
  const fork = await manager.execute({ kind: 'fork', id: sourceId, name: 'Copy', size: 'small', ttlSeconds: 7200 });
  assert.notEqual(fork.id, sourceId);
  assert.equal(fixture.boat.sandboxes.get(sourceId).state, 'archived');
  assert.equal(fixture.boat.sandboxes.get(fork.id).name, 'Copy');
  assert.notEqual(ownProfile(await fixture.profiles(), sourceId).id, ownProfile(await fixture.profiles(), fork.id).id);
  await manager.execute({ kind: 'rename', id: fork.id, name: 'Renamed copy' });
  assert.equal((await manager.list()).find((row) => row.id === fork.id).name, 'Renamed copy');
  await manager.execute({ kind: 'extend', id: fork.id, ttlSeconds: null });
  assert.equal(fixture.boat.sandboxes.get(fork.id).archiveAfter, null);
  await manager.execute({ kind: 'extend', id: fork.id, ttlSeconds: 1800 });
  assert.notEqual(fixture.boat.sandboxes.get(fork.id).archiveAfter, null);
  fixture.boat.sandboxes.get(fork.id).health = 'degraded';
  await manager.execute({ kind: 'recover', id: fork.id });
  assert.equal(fixture.boat.sandboxes.get(fork.id).health, 'ok');
  await manager.execute({ kind: 'snapshot', id: fork.id, name: 'saved-copy', confirmation: 'saved-copy' });
  assert.equal(fixture.boat.snapshots.get('saved-copy').status, 'ready');
  const snapshots = await manager.execute({ kind: 'snapshots' });
  assert.ok(JSON.stringify(snapshots).includes('saved-copy'));
  const external = fixture.boat.allocate({ name: 'External machine' });
  assert.equal((await manager.list()).find((row) => row.id === external.id).managed, false);
  await manager.execute({ kind: 'adopt', id: external.id });
  const adopted = ownProfile(await fixture.profiles(), external.id);
  await manager.execute({ kind: 'adopt', id: external.id });
  assert.equal(ownProfile(await fixture.profiles(), external.id).id, adopted.id);
  await manager.execute({ kind: 'forget', id: external.id });
  assert.ok(fixture.boat.sandboxes.has(external.id), 'Forget must not delete the cloud machine');
  assert.equal((await manager.list()).find((row) => row.id === external.id).managed, false);
  assert.ok(!(await fixture.profiles()).some((profile) => profile.id === adopted.id));
});

test('unsafe operations require exact typed consent before making cloud changes', async (t) => {
  const { fixture, manager } = await context(t);
  const id = await create(manager);
  for (const command of [
    { kind: 'stop', id }, { kind: 'stop', id, confirmation: `${id} ` },
    { kind: 'delete', id }, { kind: 'delete', id, confirmation: 'yes' },
    { kind: 'snapshot', id, name: 'replace-me' }, { kind: 'snapshot', id, name: 'replace-me', confirmation: id },
  ]) {
    const before = cloudWrites(fixture.boat).length;
    await assert.rejects(manager.execute(command));
    assert.equal(cloudWrites(fixture.boat).length, before, `${command.kind} without exact confirmation must not mutate Boat`);
  }
  assert.equal(fixture.boat.sandboxes.get(id).state, 'ready');
  assert.equal(ownProfile(await fixture.profiles(), id).enabled, true);
});

test('all pages and unknown cloud states remain visible without unsafe registration', async (t) => {
  const { fixture, manager } = await context(t);
  const known = fixture.boat.allocate({ name: 'Page one' });
  const unknown = fixture.boat.allocate({ name: 'Page two', state: 'future-state' });
  fixture.boat.allocate({ name: 'Page three', state: 'archived' });
  const rows = await manager.list();
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.id === unknown.id).state, 'future-state');
  assert.ok(rows.some((row) => row.id === known.id));
  await assert.rejects(manager.execute({ kind: 'adopt', id: unknown.id }));
  assert.deepEqual(await fixture.profiles(), [UNRELATED_PROFILE]);
  assert.equal(fixture.boat.requests.filter((request) => request.path.endsWith('/sshkey')).length, 0);
  fixture.boat.snapshots.set('first', { name: 'first', status: 'ready', sourceSandboxId: known.id, createdAt: '2026-10-01T00:00:00Z' });
  fixture.boat.snapshots.set('second', { name: 'second', status: 'ready', sourceSandboxId: known.id, createdAt: '2026-10-01T00:00:00Z' });
  const snapshots = JSON.stringify(await manager.execute({ kind: 'snapshots' }));
  assert.ok(snapshots.includes('first') && snapshots.includes('second'), 'Saved snapshot pagination must not truncate visible results');
});

test('API failures are errors rather than an empty machine catalog', async (t) => {
  const { fixture, manager } = await context(t);
  fixture.boat.failNext('GET', '/sandboxes', 503, 'provider_unavailable');
  await assert.rejects(manager.list(), (error) => {
    assert.ok(/503|provider_unavailable|unavailable/i.test(error.message));
    assert.ok(!error.message.includes(FIXTURE_TOKEN));
    return true;
  });
  fixture.boat.failNext('POST', '/sandboxes', 402, 'payment_required');
  await assert.rejects(manager.execute({ kind: 'create', name: 'Cannot bill' }));
  assert.equal(fixture.boat.sandboxes.size, 0);
  assert.deepEqual(await fixture.profiles(), [UNRELATED_PROFILE]);
});

test('local registration failure preserves cloud identity and sync repairs without allocating another sandbox', async (t) => {
  const { fixture, manager } = await context(t);
  await fixture.failHerdr('add');
  let observedError;
  try { await manager.execute({ kind: 'create', name: 'Recoverable' }); } catch (error) { observedError = error; }
  assert.ok(observedError, 'Registration failure must be reported');
  assert.equal(fixture.boat.sandboxes.size, 1, 'Cloud allocation must remain intact');
  const [id] = fixture.boat.sandboxes.keys();
  assert.ok(`${observedError.message} ${JSON.stringify(observedError)}`.includes(id), 'Failure must retain the billable resource ID');
  assert.equal(fixture.boat.requests.filter((request) => request.method === 'DELETE').length, 0, 'Local failure must never roll back cloud allocation');
  const row = (await manager.list()).find((item) => item.id === id);
  assert.equal(row.managed, true, 'Partial success must remain recoverable after a new invocation');
  await fixture.failHerdr(null);
  const restarted = await createManager({ env: fixture.env });
  await restarted.execute({ kind: 'sync', id });
  assert.equal(ownProfile(await fixture.profiles(), id).enabled, true);
  assert.equal(fixture.boat.sandboxes.size, 1);
  assert.equal(fixture.boat.requests.filter((request) => request.method === 'POST' && request.path === '/sandboxes').length, 1);
});

test('profile repair reuses a unique alias after its saved profile ID disappears', async (t) => {
  const { fixture, manager } = await context(t);
  const id = await create(manager);
  const initial = ownProfile(await fixture.profiles(), id);
  await fixture.setProfiles((await fixture.profiles()).map((profile) => profile.id === initial.id ? { ...profile, id: 'externally-replaced-id' } : profile));
  await manager.execute({ kind: 'sync', id });
  assert.equal(ownProfile(await fixture.profiles(), id).id, 'externally-replaced-id');
  assert.equal((await manager.list()).find((row) => row.id === id).profileId, 'externally-replaced-id');
});

test('a saved Herdr profile ID is never trusted after its target changes', async (t) => {
  const { fixture, manager } = await context(t);
  const id = await create(manager);
  const initial = ownProfile(await fixture.profiles(), id);
  const replacement = { ...initial, target: 'user-repurposed-target', session: 'private-session' };
  await fixture.setProfiles((await fixture.profiles()).map((profile) => profile.id === initial.id ? replacement : profile));
  await assert.rejects(manager.execute({ kind: 'sync', id }));
  assert.deepEqual((await fixture.profiles()).find((profile) => profile.id === initial.id), replacement);
});

test('async deletion retains operation identity across failure and only removes local registration on completion', async (t) => {
  const { fixture, manager } = await context(t);
  const id = await create(manager);
  const profile = ownProfile(await fixture.profiles(), id);
  const operationId = 'bdop_00000000000000000000000000000001';
  fixture.boat.failNext('GET', `/deletion-operations/${operationId}`, 503);
  await assert.rejects(manager.execute({ kind: 'delete', id, confirmation: id }));
  assert.equal(ownProfile(await fixture.profiles(), id).enabled, false);
  const rows = await manager.list();
  const pending = rows.find((row) => row.id === id);
  assert.equal(pending.deletionOperationId, operationId);
  assert.equal(pending.state, 'missing');
  const accepted = fixture.boat.requests.find((request) => request.method === 'DELETE');
  assert.equal(accepted.headers['x-ascii-confirm-delete'], id);
  const restarted = await createManager({ env: fixture.env });
  await restarted.execute({ kind: 'delete', id, confirmation: id });
  assert.equal(fixture.boat.operations.get(operationId).status, 'completed');
  assert.equal(fixture.boat.requests.filter((request) => request.method === 'DELETE').length, 1, 'Resuming a tracked deletion must not resubmit deletion');
  assert.ok(!(await fixture.profiles()).some((item) => item.id === profile.id));
  assert.ok(!(await restarted.list()).some((row) => row.id === id));
  const status = await restarted.execute({ kind: 'deletion', operationId });
  assert.ok(JSON.stringify(status).includes('completed'));
  assert.deepEqual((await fixture.profiles()).find((item) => item.id === UNRELATED_PROFILE.id), UNRELATED_PROFILE);
});

test('API key setup remains private and no secret reaches state, SSH config, process arguments or CLI output', async (t) => {
  const { fixture, manager } = await context(t);
  const setup = await fixture.cli(['setup', '--key-stdin'], { input: `${FIXTURE_TOKEN}\n` });
  assert.equal(setup.code, 0, setup.stderr);
  assert.ok(!`${setup.stdout}${setup.stderr}`.includes(FIXTURE_TOKEN));
  const config = JSON.parse(await readFile(join(fixture.configDir, 'config.json'), 'utf8'));
  assert.equal(config.apiKey, FIXTURE_TOKEN);
  assert.equal((await stat(join(fixture.configDir, 'config.json'))).mode & 0o077, 0);
  delete fixture.env.BOAT_API_KEY;
  await create(manager);
  for (const file of [...await filesBelow(fixture.stateDir), ...await filesBelow(join(fixture.home, '.ssh'))]) {
    assert.ok(!file.content.includes(FIXTURE_TOKEN), `Secret leaked to ${file.path}`);
  }
  assert.ok(!(await readFile(fixture.logPath, 'utf8')).includes(FIXTURE_TOKEN));
  const output = await fixture.cli(['list']);
  assert.equal(output.code, 0, output.stderr);
  assert.ok(!`${output.stdout}${output.stderr}`.includes(FIXTURE_TOKEN));
});

test('CLI rejects malformed flags and unsafe consent without provider mutations', async (t) => {
  const { fixture } = await context(t);
  const id = fixture.boat.allocate().id;
  for (const args of [
    ['create', '--name', 'Bad', '--bogus'], ['create', '--name', 'Bad', '--ttl', '12', '--no-auto-stop'],
    ['create', '--name', 'Bad', '--size', 'gigantic'], ['extend', id], ['stop', id], ['delete', id, '--confirm', 'yes'],
    ['snapshot', id, 'name', '--confirm', 'wrong'], ['resume'], ['adopt', 'not-a-sandbox-id'],
  ]) {
    const result = await fixture.cli(args);
    assert.notEqual(result.code, 0, `Invalid command should fail: ${args.join(' ')}`);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(FIXTURE_TOKEN));
  }
  assert.equal(cloudWrites(fixture.boat).length, 0);
});

test('independent invocations cannot interleave mutations of shared local files', async (t) => {
  const { fixture } = await context(t);
  const held = fixture.boat.hold('POST', '/sandboxes');
  const first = fixture.cli(['create', '--name', 'Lock holder']);
  await held.ready;
  let second;
  try { second = await fixture.cli(['create', '--name', 'Competing invocation']); } finally { held.release(); }
  const completed = await first;
  assert.equal(completed.code, 0, completed.stderr);
  assert.notEqual(second.code, 0, 'Concurrent mutation must fail busy rather than lose local state');
  assert.equal(fixture.boat.sandboxes.size, 1);
  assert.equal((await fixture.profiles()).length, 2);
  const after = await fixture.command('create', '--name', 'After release');
  assert.ok(after.id);
  assert.equal(fixture.boat.sandboxes.size, 2);
});

test('symlinked user SSH config is refused without altering its target or deleting cloud resources', async (t) => {
  const { fixture, manager } = await context(t);
  const target = join(fixture.root, 'external ssh config');
  await writeFile(target, UNRELATED_SSH);
  const { unlink } = await import('node:fs/promises');
  await unlink(join(fixture.home, '.ssh', 'config'));
  await symlink(target, join(fixture.home, '.ssh', 'config'));
  await assert.rejects(manager.execute({ kind: 'create', name: 'No unsafe writes' }));
  assert.equal(await readFile(target, 'utf8'), UNRELATED_SSH);
  assert.equal(fixture.boat.requests.filter((request) => request.method === 'DELETE').length, 0);
});

test('bindings cannot silently migrate to a different organization', async (t) => {
  const { fixture, manager } = await context(t);
  const id = await create(manager);
  const scoped = await createManager({ env: { ...fixture.env, BOAT_ORG: 'team_other' } });
  const before = cloudWrites(fixture.boat).length;
  await assert.rejects(scoped.execute({ kind: 'sync', id }));
  await assert.rejects(scoped.execute({ kind: 'resume', id }));
  assert.equal(cloudWrites(fixture.boat).length, before);
});

test('stored keys cannot be silently redirected to a different API origin', async (t) => {
  const { fixture } = await context(t);
  await writeFile(join(fixture.configDir, 'config.json'), JSON.stringify({ apiKey: 'boat_production_secret', apiUrl: 'https://boat.dev/api/v1' }), { mode: 0o600 });
  const env = { ...fixture.env };
  delete env.BOAT_API_KEY;
  await assert.rejects(async () => {
    const manager = await createManager({ env });
    await manager.list();
  });
  assert.equal(fixture.boat.requests.length, 0, 'A URL override must not receive credentials bound to another origin');
  const explicit = await createManager({ env: fixture.env });
  assert.deepEqual(await explicit.list(), []);
  assert.equal(fixture.boat.requests.length, 1, 'An explicitly supplied key authorizes its explicitly supplied API');
});

test('owned SSH entries reject inherited trust commands, DNS trust, agent forwarding and multiplexing', async (t) => {
  const { fixture, manager } = await context(t);
  const inherited = `${UNRELATED_SSH}Host *\n  GlobalKnownHostsFile /tmp/fixture-system-known-hosts\n  KnownHostsCommand /usr/bin/false\n  VerifyHostKeyDNS yes\n  ControlPath /tmp/fixture-control-socket\n  ForwardAgent yes\n  StrictHostKeyChecking no\n`;
  await writeFile(join(fixture.home, '.ssh', 'config'), inherited);
  const id = await create(manager);
  await assertSecureSsh(fixture, ownProfile(await fixture.profiles(), id));
  assert.ok((await readFile(join(fixture.home, '.ssh', 'config'), 'utf8')).endsWith(inherited));
});

test('different state roots sharing one HOME preserve both managed SSH aliases during concurrent create', async (t) => {
  const { fixture, manager } = await context(t);
  const alternateState = join(fixture.root, 'other state with spaces');
  await mkdir(alternateState);
  const other = await createManager({ env: { ...fixture.env, HERDR_PLUGIN_STATE_DIR: alternateState } });
  const results = await Promise.allSettled([
    manager.execute({ kind: 'create', name: 'First state root' }),
    other.execute({ kind: 'create', name: 'Second state root' }),
  ]);
  assert.ok(results.some((result) => result.status === 'fulfilled'), 'At least one mutation must acquire the shared local lock');
  for (const [owner, name] of [[manager, 'First state root'], [other, 'Second state root']]) {
    let sandbox = [...fixture.boat.sandboxes.values()].find((item) => item.name === name);
    if (!sandbox) {
      const result = await owner.execute({ kind: 'create', name });
      sandbox = fixture.boat.sandboxes.get(result.id);
    }
    await owner.execute({ kind: 'sync', id: sandbox.id });
    await assertSecureSsh(fixture, ownProfile(await fixture.profiles(), sandbox.id));
  }
  assert.equal((await fixture.profiles()).length, 3);
  assert.ok((await readFile(join(fixture.home, '.ssh', 'config'), 'utf8')).endsWith(UNRELATED_SSH));
});

test('provider stop refusal leaves a running machine enabled and does not force-stop', async (t) => {
  const { fixture, manager } = await context(t);
  const id = await create(manager);
  fixture.boat.failNext('POST', `/sandboxes/${id}/stop`, 409, 'snapshot_unavailable');
  await assert.rejects(manager.execute({ kind: 'stop', id, confirmation: id }));
  assert.equal(fixture.boat.sandboxes.get(id).state, 'ready');
  assert.equal(ownProfile(await fixture.profiles(), id).enabled, true);
  const attempts = fixture.boat.requests.filter((request) => request.path.endsWith('/stop'));
  assert.equal(attempts.length, 1, 'Refused stop must not retry or force');
  assert.ok(!attempts[0].query.force && !attempts[0].body.force);
});

test('provider endpoint or host pin failure leaves cloud resources retained and repairable', async (t) => {
  const { fixture, manager } = await context(t);
  fixture.boat.setSshResponse({ success: true, machineIp: '203.0.113.10', sshEndpoint: 'bad host:22', sshUser: 'user', hostKey: 'not-an-ssh-key' });
  await assert.rejects(manager.execute({ kind: 'create', name: 'Unsafe trust response' }));
  const [id] = fixture.boat.sandboxes.keys();
  assert.ok(id);
  assert.deepEqual(await fixture.profiles(), [UNRELATED_PROFILE]);
  assert.equal(fixture.boat.requests.filter((request) => request.method === 'DELETE').length, 0);
  fixture.boat.setSshResponse(undefined);
  await manager.execute({ kind: 'sync', id });
  await assertSecureSsh(fixture, ownProfile(await fixture.profiles(), id));
});

test('pagination cursor loops fail instead of hanging or presenting partial success', async (t) => {
  const { fixture, manager } = await context(t);
  fixture.boat.allocate();
  fixture.boat.allocate();
  fixture.boat.setCursorLoop(true);
  await assert.rejects(manager.list());
  assert.ok(fixture.boat.requests.length <= 4, 'A repeated pagination cursor must terminate promptly');
});

test('terminal menu exits cleanly on input EOF without cloud writes', async (t) => {
  const { fixture } = await context(t);
  const result = await fixture.cli(['manage']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(cloudWrites(fixture.boat).length, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(FIXTURE_TOKEN));
});

test('info never exposes secret-bearing desktop access URLs', async (t) => {
  const { fixture, manager } = await context(t);
  const sandbox = fixture.boat.allocate({ desktopUrl: 'https://desktop.fixture/stream?token=desktop-fixture-token' });
  const result = await fixture.cli(['info', sandbox.id]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sandbox.id, sandbox.id);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('desktop-fixture-token'));
  assert.ok(!JSON.stringify(await manager.execute({ kind: 'info', id: sandbox.id })).includes('desktop-fixture-token'));
});

test('accepted stop disables its profile even when subsequent observation fails', async (t) => {
  const { fixture, manager } = await context(t);
  const id = await create(manager);
  fixture.boat.failNext('GET', `/sandboxes/${id}`, 503, 'observation_unavailable');
  const result = await fixture.cli(['stop', id, '--confirm', id]);
  assert.notEqual(result.code, 0);
  assert.equal(fixture.boat.sandboxes.get(id).state, 'archived');
  assert.equal(ownProfile(await fixture.profiles(), id).enabled, false);
});

test('a dotfiles-linked Herdr config root supports setup and the saved credential', async (t) => {
  const { fixture } = await context(t);
  const target = join(fixture.root, 'dotfiles', 'herdr');
  await mkdir(target, { recursive: true });
  await mkdir(join(fixture.home, '.config'), { recursive: true });
  await symlink(target, join(fixture.home, '.config', 'herdr'));
  fixture.env.HERDR_PLUGIN_CONFIG_DIR = join(fixture.home, '.config', 'herdr', 'plugins', 'config', 'boat.machines');
  const setup = await fixture.cli(['setup', '--key-stdin'], { input: `${FIXTURE_TOKEN}\n` });
  assert.equal(setup.code, 0, setup.stderr);
  const saved = join(target, 'plugins', 'config', 'boat.machines', 'config.json');
  assert.equal(JSON.parse(await readFile(saved, 'utf8')).apiKey, FIXTURE_TOKEN);
  assert.equal((await stat(saved)).mode & 0o077, 0);
  delete fixture.env.BOAT_API_KEY;
  const result = await fixture.command('create', '--name', 'Dotfiles configuration');
  assert.equal(ownProfile(await fixture.profiles(), result.id).enabled, true);
});

test('linked home and state roots preserve machine identity when addressed by their real paths', async (t) => {
  const { fixture } = await context(t);
  const homeAlias = join(fixture.root, 'linked home');
  const stateAlias = join(fixture.root, 'linked state');
  await symlink(fixture.home, homeAlias);
  await symlink(fixture.stateDir, stateAlias);
  fixture.env.HOME = homeAlias;
  fixture.env.HERDR_PLUGIN_STATE_DIR = join(stateAlias, 'new nested state');
  const created = await fixture.command('create', '--name', 'Canonical roots');
  const original = ownProfile(await fixture.profiles(), created.id);
  fixture.env.HOME = fixture.home;
  fixture.env.HERDR_PLUGIN_STATE_DIR = join(fixture.stateDir, 'new nested state');
  await fixture.command('sync', created.id);
  assert.equal(ownProfile(await fixture.profiles(), created.id).id, original.id);
  await assertSecureSsh(fixture, original);
});

test('accepting linked storage roots does not permit a symlinked credential file', async (t) => {
  const { fixture } = await context(t);
  const target = join(fixture.root, 'external credential file');
  const original = JSON.stringify({ apiKey: 'untouched-private-key' });
  await writeFile(target, original, { mode: 0o600 });
  await symlink(target, join(fixture.configDir, 'config.json'));
  const setup = await fixture.cli(['setup', '--key-stdin'], { input: `${FIXTURE_TOKEN}\n` });
  assert.notEqual(setup.code, 0);
  assert.equal(await readFile(target, 'utf8'), original);
  assert.equal(fixture.boat.requests.length, 0);
});
