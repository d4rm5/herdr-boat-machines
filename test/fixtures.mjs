import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const FIXTURE_TOKEN = 'boat_fixture';
export const UNRELATED_SSH = '# user configuration must survive byte-for-byte\nHost unrelated\n  HostName 192.0.2.99\n  User original-user\n  Port 2244\n';
export const UNRELATED_PROFILE = { id: 'user-profile', label: 'User machine', target: 'unrelated', session: 'personal', enabled: true, selected: true };
const iso = '2026-10-01T12:00:00.000Z';
const hostKey = () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const key = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const prefix = Buffer.from('0000000b7373682d6564323535313900000020', 'hex');
  return `ssh-ed25519 ${Buffer.concat([prefix, key]).toString('base64')}`;
};
export const HOST_KEYS = [hostKey(), hostKey()];

export async function runProcess(file, args, { env, input = '', timeout = 30000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { env, cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Process timed out: ${file} ${args.join(' ')}`));
    }, timeout);
    child.stdout.setEncoding('utf8').on('data', (value) => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', (value) => { stderr += value; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function startBoat() {
  const sandboxes = new Map();
  const snapshots = new Map();
  const operations = new Map();
  const requests = [];
  const failures = [];
  const holds = new Map();
  let nextId = 0;
  let pageSize = 1;
  let cursorLoop = false;
  let sshResponse;
  const allocate = (input = {}) => {
    const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
    const id = `bx_${alphabet[nextId++]}3456789`;
    const sandbox = { id, name: input.name || `Sandbox ${nextId}`, state: 'ready', type: input.type || 'default', archiveAfter: input.ttlSeconds === null ? null : '2026-10-01T13:00:00.000Z', desktopAvailable: false, snapshotAvailable: true, health: 'ok', ip: '203.0.113.10', generation: 0, ...input };
    sandboxes.set(id, sandbox);
    return sandbox;
  };
  const envelope = (type, body = {}) => ({ ok: true, type, ...body });
  const errorEnvelope = (status, code, message) => ({ ok: false, type: 'sandbox.error', status, code, message, requestId: 'req_fixture', error: { status, code, message } });
  const paginate = (values, url) => {
    const offset = Number(url.searchParams.get('cursor') || 0);
    const next = offset + pageSize < values.length ? String(offset + pageSize) : null;
    return { items: values.slice(offset, offset + pageSize), pageInfo: { nextCursor: cursorLoop ? '1' : next, hasMore: cursorLoop || next !== null, limit: pageSize } };
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = url.pathname.replace(/^\/api\/v1/, '');
      let source = '';
      for await (const part of request) source += part;
      const body = source ? JSON.parse(source) : undefined;
      const entry = { method: request.method, path, query: Object.fromEntries(url.searchParams), headers: { ...request.headers }, body };
      requests.push(entry);
      const send = (status, value) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.headers.authorization !== `Bearer ${FIXTURE_TOKEN}`) return send(401, errorEnvelope(401, 'unauthorized', 'Unauthorized'));
      const failureIndex = failures.findIndex((failure) => failure.method === request.method && failure.path === path);
      if (failureIndex >= 0) {
        const failure = failures.splice(failureIndex, 1)[0];
        return send(failure.status, errorEnvelope(failure.status, failure.code || 'fixture_failure', failure.message || 'Fixture provider unavailable'));
      }
      const hold = holds.get(`${request.method} ${path}`);
      if (hold) { hold.reached(); await hold.promise; holds.delete(`${request.method} ${path}`); }
      if (path === '/sandboxes' && request.method === 'GET') {
        const page = paginate([...sandboxes.values()], url);
        return send(200, envelope('sandbox.list', { sandboxes: page.items, pageInfo: page.pageInfo }));
      }
      if (path === '/sandboxes' && request.method === 'POST') {
        const sandbox = allocate(body);
        return send(202, envelope('sandbox.created', { status: 'provisioning', ttlSeconds: body.ttlSeconds, sandbox: { ...sandbox, state: 'provisioning' } }));
      }
      if (path === '/saved-snapshots' && request.method === 'GET') {
        const page = paginate([...snapshots.values()], url);
        return send(200, envelope('snapshot.saved.list', { snapshots: page.items, pageInfo: page.pageInfo }));
      }
      if (path === '/saved-snapshots' && request.method === 'POST') {
        const snapshot = { name: body.name, sourceSandboxId: body.sandboxId, status: 'saving', createdAt: iso, type: sandboxes.get(body.sandboxId)?.type || 'default' };
        snapshots.set(snapshot.name, snapshot);
        return send(202, envelope('snapshot.saved.saving', { status: 'saving', snapshot }));
      }
      if (path.startsWith('/saved-snapshots/') && request.method === 'GET') {
        const snapshot = snapshots.get(decodeURIComponent(path.slice('/saved-snapshots/'.length)));
        if (!snapshot) return send(404, errorEnvelope(404, 'not_found', 'Snapshot not found'));
        if (snapshot.status === 'saving') snapshot.status = 'ready';
        return send(200, envelope('snapshot.saved.info', { snapshot }));
      }
      if (path.startsWith('/deletion-operations/') && request.method === 'GET') {
        const operation = operations.get(path.split('/')[2]);
        if (!operation) return send(404, errorEnvelope(404, 'not_found', 'Deletion not found'));
        if (!operation.paused && ++operation.polls >= 2) {
          operation.status = 'completed';
          operation.completedAt = iso;
          operation.stage = 'completed';
        }
        return send(200, envelope('deletion.operation', { operation }));
      }
      const match = path.match(/^\/sandboxes\/(bx_[^/]+)(?:\/(.*))?$/);
      if (match) {
        const [, id, action] = match;
        const sandbox = sandboxes.get(id);
        if (!sandbox) return send(404, errorEnvelope(404, 'not_found', `Sandbox ${id} not found`));
        if (!action && request.method === 'GET') return send(200, envelope('sandbox.info', { sandbox }));
        if (!action && request.method === 'PATCH') {
          Object.assign(sandbox, body);
          if ('ttlSeconds' in body) sandbox.archiveAfter = body.ttlSeconds === null ? null : '2026-10-01T18:00:00.000Z';
          return send(200, envelope('sandbox.updated', { sandbox }));
        }
        if (!action && request.method === 'DELETE') {
          if (request.headers['x-ascii-confirm-delete'] !== id) return send(409, errorEnvelope(409, 'confirmation_required', 'Deletion needs exact target confirmation'));
          const operation = { id: `bdop_${(operations.size + 1).toString(16).padStart(32, '0')}`, kind: 'sandbox', targetId: id, reason: 'explicit', status: 'pending', stage: 'removing', attemptCount: 0, requestedAt: iso, completedAt: null, polls: 0 };
          operations.set(operation.id, operation);
          sandboxes.delete(id);
          return send(202, envelope('sandbox.deleting', { operation }));
        }
        if (action === 'sshkey' && request.method === 'POST') {
          if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: |$)/.test(body.key)) return send(400, errorEnvelope(400, 'invalid_key', 'Expected an OpenSSH public key'));
          const generation = sandbox.generation % 2;
          return send(200, envelope('ssh_key.configured', sshResponse || { success: true, machineIp: generation ? '203.0.113.20' : '203.0.113.10', sshEndpoint: generation ? '203.0.113.20:22002' : '203.0.113.10:22001', sshUser: 'user', hostKey: HOST_KEYS[generation] }));
        }
        if (action === 'stop' && request.method === 'POST') {
          sandbox.state = 'archived';
          sandbox.stop = { id: 'stop_fixture', status: 'completed' };
          return send(202, envelope('sandbox.stopping', { id, status: 'archiving', sandbox: { ...sandbox, state: 'archiving' }, stop: { id: sandbox.stop.id, status: 'pending' } }));
        }
        if (action === 'resume' && request.method === 'POST') {
          Object.assign(sandbox, body, { state: 'ready', generation: sandbox.generation + 1, health: 'ok' });
          return send(202, envelope('sandbox.resuming', { sandbox: { ...sandbox, state: 'provisioning' }, id, status: 'resuming' }));
        }
        if (action === 'fork' && request.method === 'POST') {
          const fork = allocate({ ...body, name: `${sandbox.name} fork` });
          return send(202, envelope('sandbox.forking', { id: fork.id, status: 'forking', sandbox: { ...fork, state: 'provisioning' } }));
        }
        if (action === 'recover' && request.method === 'POST') {
          sandbox.health = 'ok';
          sandbox.state = 'ready';
          return send(200, envelope('sandbox.recovering', { status: 'recovering', sandbox, id }));
        }
      }
      return send(404, errorEnvelope(404, 'unknown_endpoint', `${request.method} ${path}`));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, message: error.message }));
    }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return {
    apiUrl: `http://127.0.0.1:${server.address().port}/api/v1`, sandboxes, snapshots, operations, requests, allocate,
    failNext(method, path, status = 503, code, message) { failures.push({ method, path, status, code, message }); },
    setPageSize(value) { pageSize = value; },
    setCursorLoop(value) { cursorLoop = value; },
    setSshResponse(value) { sshResponse = value; },
    hold(method, path) {
      let release;
      let reached;
      const ready = new Promise((done) => { reached = done; });
      const promise = new Promise((done) => { release = done; });
      holds.set(`${method} ${path}`, { promise, reached });
      return { ready, release };
    },
    async close() { server.closeAllConnections(); await new Promise((done) => server.close(done)); },
  };
}

export async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'herdr boat fixture '));
  const home = join(root, 'home with spaces');
  const configDir = join(root, 'config with spaces');
  const stateDir = join(root, 'state with spaces');
  const catalogPath = join(root, 'herdr profiles.json');
  const controlPath = join(root, 'herdr control.json');
  const logPath = join(root, 'herdr calls.jsonl');
  const herdrPath = join(root, 'herdr fixture.mjs');
  const boat = await startBoat();
  await Promise.all([mkdir(join(home, '.ssh'), { recursive: true }), mkdir(configDir), mkdir(stateDir)]);
  await writeFile(join(home, '.ssh', 'config'), UNRELATED_SSH);
  await writeFile(catalogPath, JSON.stringify({ nextId: 1, profiles: [UNRELATED_PROFILE] }));
  await writeFile(controlPath, '{}');
  await writeFile(logPath, '');
  await copyFile(new URL('./herdr.fixture', import.meta.url), herdrPath);
  await chmod(herdrPath, 0o700);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local', 'state'), BOAT_API_KEY: FIXTURE_TOKEN, BOAT_API_URL: boat.apiUrl, HERDR_BIN_PATH: herdrPath, HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_FIXTURE_CATALOG: catalogPath, HERDR_FIXTURE_CONTROL: controlPath, HERDR_FIXTURE_LOG: logPath };
  delete env.BOAT_ORG;
  const cli = (args, options = {}) => runProcess(process.execPath, [join(projectRoot, 'src', 'cli.mjs'), ...args], { env, ...options });
  return {
    root, home, configDir, stateDir, env, boat, catalogPath, logPath,
    cli,
    async command(...args) {
      const result = await cli(args);
      assert.equal(result.code, 0, `CLI ${args[0]} failed: ${result.stderr}\n${result.stdout}`);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(FIXTURE_TOKEN), 'CLI must not reveal the API key');
      return JSON.parse(result.stdout);
    },
    async profiles() { return JSON.parse(await readFile(catalogPath, 'utf8')).profiles; },
    async setProfiles(profiles) {
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
      await writeFile(catalogPath, JSON.stringify({ ...catalog, profiles }));
    },
    async failHerdr(action) { await writeFile(controlPath, JSON.stringify(action ? { action } : {})); },
    async ssh(alias) {
      const result = await runProcess('ssh', ['-G', '-F', join(home, '.ssh', 'config'), alias], { env });
      assert.equal(result.code, 0, `OpenSSH could not parse generated configuration: ${result.stderr}`);
      return Object.fromEntries(result.stdout.trim().split('\n').map((line) => { const split = line.indexOf(' '); return [line.slice(0, split), line.slice(split + 1)]; }));
    },
    async close() { await boat.close(); await rm(root, { recursive: true, force: true }); },
  };
}

export async function filesBelow(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(child));
    else if (entry.isFile()) files.push({ path: child, content: await readFile(child, 'utf8'), mode: (await stat(child)).mode & 0o777 });
  }
  return files;
}

export function ownProfile(profiles, id) {
  const matches = profiles.filter((profile) => profile.target.includes(id));
  assert.equal(matches.length, 1, `Exactly one Herdr machine should target ${id}`);
  return matches[0];
}

export async function assertSecureSsh(harness, profile, generation = 0) {
  const alias = profile.target.replace(/^ssh:\/\//, '').replace(/^[^@]+@/, '');
  const options = await harness.ssh(alias);
  assert.equal(options.hostname, generation ? '203.0.113.20' : '203.0.113.10');
  assert.equal(options.port, generation ? '22002' : '22001');
  assert.equal(options.user, 'user');
  assert.equal(options.stricthostkeychecking, 'true');
  assert.equal(options.identitiesonly, 'yes');
  assert.equal(options.forwardagent, 'no');
  assert.equal(options.updatehostkeys, 'false');
  assert.equal(options.hostkeyalias, alias);
  assert.equal(options.globalknownhostsfile, '/dev/null');
  assert.ok(options.knownhostscommand === undefined || options.knownhostscommand === 'none', 'Inherited host key commands must be disabled');
  assert.equal(options.verifyhostkeydns, 'false');
  assert.ok(options.controlpath === undefined || options.controlpath === 'none', 'Inherited connection multiplexing must be disabled');
  const knownHostsPath = options.userknownhostsfile.replace(/^"|"$/g, '');
  const knownHosts = await readFile(resolve(knownHostsPath), 'utf8');
  assert.ok(knownHosts.includes(HOST_KEYS[generation]), 'Current provider host key must be pinned');
  const identityPath = options.identityfile.replace(/^"|"$/g, '');
  const identity = await readFile(identityPath, 'utf8');
  assert.ok(identity.includes('PRIVATE KEY'), 'OpenSSH identity must refer to the owned private key');
  assert.equal((await stat(identityPath)).mode & 0o077, 0, 'Owned private key must not be accessible to other users');
  return { options, knownHostsPath, knownHosts, identityPath };
}
