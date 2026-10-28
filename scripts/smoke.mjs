#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHarness, ownProfile, assertSecureSsh, filesBelow, FIXTURE_TOKEN, UNRELATED_PROFILE, UNRELATED_SSH } from '../test/fixtures.mjs';

const fixture = await createHarness();
const proven = [];
const prove = (message) => { proven.push(message); process.stdout.write(`PASS ${message}\n`); };
try {
  const created = await fixture.command('create', '--name', 'Smoke workspace', '--size', 'small', '--ttl', '7200', '--no-env');
  const id = created.id;
  assert.match(id, /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
  assert.equal(fixture.boat.sandboxes.get(id).name, 'Smoke workspace');
  assert.equal(fixture.boat.sandboxes.get(id).type, 'small');
  const initial = ownProfile(await fixture.profiles(), id);
  const originalSsh = await assertSecureSsh(fixture, initial);
  prove('actual CLI create registers an enabled Herdr machine with OpenSSH-parseable pinned SSH');

  const external = fixture.boat.allocate({ name: 'Unmanaged page two' });
  const listed = await fixture.command('list');
  assert.ok(listed.some((row) => row.id === id && row.managed));
  assert.ok(listed.some((row) => row.id === external.id && !row.managed));
  const info = await fixture.command('info', id);
  assert.ok(JSON.stringify(info).includes(id));
  await fixture.command('sync', id);
  assert.equal(ownProfile(await fixture.profiles(), id).id, initial.id);
  prove('actual CLI list follows pagination and sync preserves the existing Herdr profile ID');

  for (const args of [['stop', id], ['delete', id, '--confirm', 'yes'], ['snapshot', id, 'smoke-image', '--confirm', 'wrong']]) {
    const before = fixture.boat.requests.filter((request) => request.method !== 'GET').length;
    const refused = await fixture.cli(args);
    assert.notEqual(refused.code, 0);
    assert.equal(fixture.boat.requests.filter((request) => request.method !== 'GET').length, before);
  }
  prove('actual CLI refuses stop, delete and snapshot replacement without exact typed consent');

  await fixture.command('stop', id, '--confirm', id);
  assert.equal(fixture.boat.sandboxes.get(id).state, 'archived');
  assert.equal(ownProfile(await fixture.profiles(), id).enabled, false);
  await fixture.command('resume', id, '--size', 'large');
  const resumed = ownProfile(await fixture.profiles(), id);
  assert.equal(resumed.id, initial.id);
  assert.equal(resumed.enabled, true);
  assert.equal(fixture.boat.sandboxes.get(id).type, 'large');
  const rotatedSsh = await assertSecureSsh(fixture, resumed, 1);
  assert.notEqual(rotatedSsh.knownHostsPath, originalSsh.knownHostsPath);
  assert.equal(await readFile(originalSsh.knownHostsPath, 'utf8'), originalSsh.knownHosts);
  prove('actual CLI stop/resume rotates IP, port and host pin without duplicating the Herdr profile');

  await fixture.command('rename', id, 'Renamed smoke workspace');
  assert.equal(fixture.boat.sandboxes.get(id).name, 'Renamed smoke workspace');
  await fixture.command('extend', id, '--no-auto-stop');
  assert.equal(fixture.boat.sandboxes.get(id).archiveAfter, null);
  await fixture.command('extend', id, '--ttl', '3600');
  assert.notEqual(fixture.boat.sandboxes.get(id).archiveAfter, null);
  fixture.boat.sandboxes.get(id).health = 'degraded';
  await fixture.command('recover', id);
  assert.equal(fixture.boat.sandboxes.get(id).health, 'ok');
  await fixture.command('snapshot', id, 'smoke-image', '--confirm', 'smoke-image');
  assert.equal(fixture.boat.snapshots.get('smoke-image').status, 'ready');
  assert.ok(JSON.stringify(await fixture.command('snapshots')).includes('smoke-image'));
  prove('actual CLI rename, timer, recover and saved snapshot operations change provider-visible state');

  await fixture.command('stop', id, '--confirm', id);
  const fork = await fixture.command('fork', id, '--name', 'Smoke copy', '--size', 'small');
  assert.notEqual(fork.id, id);
  assert.equal(fixture.boat.sandboxes.get(id).state, 'archived');
  const forkProfile = ownProfile(await fixture.profiles(), fork.id);
  assert.notEqual(forkProfile.id, initial.id);
  await fixture.command('forget', fork.id);
  assert.ok(fixture.boat.sandboxes.has(fork.id));
  assert.ok(!(await fixture.profiles()).some((profile) => profile.id === forkProfile.id));
  await fixture.command('adopt', fork.id);
  await fixture.command('sync', fork.id);
  ownProfile(await fixture.profiles(), fork.id);
  prove('actual CLI fork creates a separate identity and forget/adopt manages only local ownership');

  await fixture.failHerdr('add');
  const failedCreate = await fixture.cli(['create', '--name', 'Repairable smoke machine']);
  assert.notEqual(failedCreate.code, 0);
  const repairable = [...fixture.boat.sandboxes.values()].find((sandbox) => sandbox.name === 'Repairable smoke machine');
  assert.ok(repairable, 'Local failure must leave the billed cloud resource available');
  assert.ok(`${failedCreate.stdout}${failedCreate.stderr}`.includes(repairable.id), 'Failure must show the retained resource ID');
  assert.equal(fixture.boat.requests.filter((request) => request.method === 'DELETE').length, 0);
  await fixture.failHerdr(null);
  await fixture.command('sync', repairable.id);
  ownProfile(await fixture.profiles(), repairable.id);
  prove('actual CLI local registration failure preserves its cloud ID and a later invocation repairs it');

  for (const target of [id, fork.id, repairable.id]) {
    await fixture.command('delete', target, '--confirm', target);
    assert.ok(!fixture.boat.sandboxes.has(target));
    const operation = [...fixture.boat.operations.values()].find((item) => item.targetId === target);
    assert.equal(operation.status, 'completed');
    assert.ok(operation.polls >= 2, 'Deletion must observe asynchronous completion, not only acceptance');
    assert.ok(JSON.stringify(await fixture.command('deletion', operation.id)).includes('completed'));
    const request = fixture.boat.requests.find((entry) => entry.method === 'DELETE' && entry.path.endsWith(target));
    assert.equal(request.headers['x-ascii-confirm-delete'], target);
  }
  assert.deepEqual(await fixture.profiles(), [UNRELATED_PROFILE]);
  assert.ok((await readFile(join(fixture.home, '.ssh', 'config'), 'utf8')).endsWith(UNRELATED_SSH));
  assert.equal((await fixture.ssh('unrelated')).hostname, '192.0.2.99');
  for (const file of [...await filesBelow(fixture.stateDir), ...await filesBelow(join(fixture.home, '.ssh'))]) {
    assert.ok(!file.content.includes(FIXTURE_TOKEN), `API key leaked to ${file.path}`);
  }
  assert.ok(!(await readFile(fixture.logPath, 'utf8')).includes(FIXTURE_TOKEN));
  prove('actual CLI delete waits for asynchronous completion and preserves unrelated profiles, SSH bytes and key secrecy');
  process.stdout.write(`PROVEN ${proven.length} lifecycle assertions through child-process plugin CLI, loopback Boat API, persisted Herdr catalog and real ssh -G. No live Boat writes.\n`);
} finally {
  await fixture.close();
}
