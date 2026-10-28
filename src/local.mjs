import { constants, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, parse } from 'node:path';
import { homedir, hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const operationPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

function pathValue(value, label) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f%*?\[\]]/.test(value)) throw new Error(`Invalid ${label} path.`);
  let current = resolve(value);
  const missing = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

async function statSafe(path, kind, optional = false) {
  let stat;
  try { stat = await lstat(path); } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) throw new Error(`Refusing unsafe ${kind} at ${path}.`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`Refusing file owned by another user at ${path}.`);
  return stat;
}

async function directory(path, owned = true) {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await mkdir(current, { mode: 0o700 }); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing unsafe directory at ${current}.`);
  }
  if (owned) {
    await statSafe(path, 'directory');
    await chmod(path, 0o700);
  }
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function checkParents(path, optional = false) {
  const parent = dirname(path);
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (optional && error.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing unsafe parent directory at ${current}.`);
  }
  return true;
}

async function readOwned(path, optional = false) {
  if (!await checkParents(path, optional)) return null;
  if (!await statSafe(path, 'file', optional)) return null;
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (stat.size > 4 * 1024 * 1024) throw new Error(`Owned file is too large at ${path}.`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function atomicWrite(path, content, { expected, immutable = false } = {}) {
  await statSafe(dirname(path), 'directory');
  const prior = await statSafe(path, 'file', true);
  if (immutable && prior) throw new Error(`Generation file already exists at ${path}.`);
  const temp = join(dirname(path), `.tmp-${randomUUID()}`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  } finally { await handle.close(); }
  try {
    await statSafe(path, 'file', true);
    if (expected !== undefined) {
      const actual = await readOwned(path, true);
      if ((actual === null) !== (expected === null) || (actual && !actual.equals(expected))) throw new Error(`File changed concurrently at ${path}; retry after reviewing it.`);
    }
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function readJson(path, optional = false) {
  const bytes = await readOwned(path, optional);
  if (bytes === null) return null;
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`Invalid JSON in ${path}.`); }
}

function validateOperationId(value) {
  if (typeof value !== 'string' || !operationPattern.test(value)) throw new Error('Invalid deletion operation ID.');
  return value;
}

function validateBinding(value, path) {
  if (!value || value.version !== 1 || !ID.test(value.id) || typeof value.alias !== 'string' || !new RegExp(`^herdr-boat-${value.id}-[a-f0-9]{12}$`).test(value.alias) || value.session !== 'default' || !(value.profileId === null || (typeof value.profileId === 'string' && value.profileId.length > 0 && !/[\x00-\x1f\x7f]/.test(value.profileId))) || typeof value.apiUrl !== 'string' || !(value.org === null || typeof value.org === 'string')) throw new Error(`Invalid binding in ${path}.`);
  if (value.deletionOperationId !== undefined) validateOperationId(value.deletionOperationId);
  return value;
}

async function acquireLock(path) {
  const guard = `${path}.reclaim`;
  if (await statSafe(guard, 'directory', true)) throw new Error('Boat manager is busy recovering a lock.');
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await statSafe(path, 'directory');
    const owner = await readJson(join(path, 'owner.json'), true);
    if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string') throw new Error('Boat manager is busy; its mutation lock cannot safely be reclaimed.');
    let dead = false;
    try { process.kill(owner.pid, 0); } catch (cause) { if (cause.code === 'ESRCH') dead = true; }
    if (!dead) throw new Error(`Boat manager is busy in process ${owner.pid}.`);
    try { await mkdir(guard, { mode: 0o700 }); } catch (cause) {
      if (cause.code === 'EEXIST') throw new Error('Boat manager is busy recovering a lock.');
      throw cause;
    }
    try {
      const current = await readJson(join(path, 'owner.json'), true);
      if (current?.token !== owner.token) throw new Error('Boat manager lock changed while recovering it.');
      const quarantine = `${path}.dead-${randomUUID()}`;
      await rename(path, quarantine);
      await rm(quarantine, { recursive: true });
    } finally { await rm(guard, { recursive: true }); }
    return acquireLock(path);
  }
  const token = randomUUID();
  try {
    if (await statSafe(guard, 'directory', true)) throw new Error('Boat manager is busy recovering a lock.');
    await atomicWrite(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), token }));
  } catch (error) {
    await rm(path, { recursive: true });
    throw error;
  }
  return async () => {
    const owner = await readJson(join(path, 'owner.json'), true);
    if (owner?.token !== token) throw new Error('Refusing to release a changed mutation lock.');
    await rm(path, { recursive: true });
  };
}

function run(binary, args, env, inherited = false) {
  return new Promise((resolveRun, reject) => {
    const childEnv = { ...env };
    delete childEnv.BOAT_API_KEY;
    const child = spawn(binary, args, { env: childEnv, shell: false, stdio: inherited ? ['inherit', 2, 2] : ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let excessive = false;
    if (!inherited) {
      for (const [stream, append] of [[child.stdout, value => { stdout += value; }], [child.stderr, value => { stderr += value; }]]) {
        stream.setEncoding('utf8');
        stream.on('data', value => {
          size += Buffer.byteLength(value);
          if (size > 4 * 1024 * 1024) { excessive = true; child.kill(); } else append(value);
        });
      }
    }
    child.on('error', error => reject(new Error(`Unable to run ${binary}: ${error.message}`)));
    child.on('close', (code, signal) => {
      if (excessive) reject(new Error(`${binary} produced excessive output.`));
      else if (code !== 0) reject(new Error(`${binary} failed${signal ? ` with signal ${signal}` : ` with exit ${code}`}.${stderr ? ` ${stderr.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 2000)}` : ''}`));
      else resolveRun(stdout);
    });
  });
}

function quote(value) {
  if (/[\x00-\x1f\x7f%]/.test(value)) throw new Error('Unsupported SSH path.');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function host(value) {
  if (typeof value !== 'string' || value.length > 253 || !value) throw new Error('Invalid SSH host from Boat.');
  if (isIP(value)) return value;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) || value.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) throw new Error('Invalid SSH host from Boat.');
  return value;
}

function parseSsh(response) {
  if (response.success === false) throw new Error('Boat did not authorize the plugin SSH key.');
  let hostname;
  let port = 22;
  if (response.sshEndpoint !== undefined && response.sshEndpoint !== null && response.sshEndpoint !== '') {
    if (typeof response.sshEndpoint !== 'string') throw new Error('Invalid SSH endpoint from Boat.');
    const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/.exec(response.sshEndpoint);
    if (!match) throw new Error('Invalid SSH endpoint from Boat.');
    hostname = host(match[1] ?? match[2]);
    port = Number(match[3]);
    if (port < 1 || port > 65535 || (match[1] && isIP(hostname) !== 6)) throw new Error('Invalid SSH endpoint port or IPv6 host.');
  } else {
    if (typeof response.machineIp !== 'string' || !isIP(response.machineIp)) throw new Error('Boat did not supply a valid SSH machine IP.');
    hostname = response.machineIp;
  }
  if (typeof response.sshUser !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?$/.test(response.sshUser)) throw new Error('Boat did not supply a valid SSH user.');
  if (typeof response.hostKey !== 'string' || /[\r\n\x00]/.test(response.hostKey)) throw new Error('Boat did not supply a valid pinned SSH host key.');
  const match = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: [^\x00-\x1f\x7f]*)?$/.exec(response.hostKey);
  if (!match) throw new Error('Boat did not supply a supported pinned SSH host key.');
  const blob = Buffer.from(match[2], 'base64');
  let offset = 0;
  function field() {
    if (offset + 4 > blob.length) throw new Error('Malformed SSH host key from Boat.');
    const length = blob.readUInt32BE(offset);
    offset += 4;
    if (length > blob.length - offset) throw new Error('Malformed SSH host key from Boat.');
    const result = blob.subarray(offset, offset + length);
    offset += length;
    return result;
  }
  if (field().toString('ascii') !== match[1]) throw new Error('SSH host key algorithm does not match its encoded key.');
  if (match[1] === 'ssh-ed25519') {
    if (field().length !== 32) throw new Error('Invalid Ed25519 SSH host key.');
  } else if (match[1] === 'ssh-rsa') {
    if (field().length < 1 || field().length < 128) throw new Error('Invalid RSA SSH host key.');
  } else {
    const curve = match[1].slice('ecdsa-sha2-'.length);
    if (field().toString('ascii') !== curve || field().length !== ({ nistp256: 65, nistp384: 97, nistp521: 133 })[curve]) throw new Error('Invalid ECDSA SSH host key.');
  }
  if (offset !== blob.length || blob.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) throw new Error('Malformed SSH host key from Boat.');
  return { hostname, port, user: response.sshUser, hostKey: `${match[1]} ${match[2]}` };
}

export async function openLocal({ env = process.env } = {}) {
  const home = pathValue(env.HOME || homedir(), 'home');
  const configDir = pathValue(env.HERDR_PLUGIN_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'herdr/plugins/config/boat.machines'), 'config');
  const stateDir = pathValue(env.HERDR_PLUGIN_STATE_DIR || join(env.XDG_STATE_HOME || join(home, '.local/state'), 'herdr/plugins/boat.machines'), 'state');
  const sshDir = join(home, '.ssh', 'herdr-boat');
  const bindingsDir = join(stateDir, 'bindings');
  const configPath = join(configDir, 'config.json');
  const keyPath = join(stateDir, 'id_ed25519');
  const herdr = env.HERDR_BIN_PATH || 'herdr';
  if (typeof herdr !== 'string' || !herdr || /[\x00-\x1f\x7f]/.test(herdr)) throw new Error('Invalid HERDR_BIN_PATH.');

  function aliasFor(id, apiUrl, org) {
    const scope = createHash('sha256').update(JSON.stringify([stateDir, apiUrl, org])).digest('hex').slice(0, 12);
    return `herdr-boat-${id}-${scope}`;
  }

  async function readConfig() {
    const value = await readJson(configPath, true) ?? {};
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Boat config must be a JSON object.');
    for (const key of ['apiKey', 'org', 'apiUrl']) {
      if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key] || /[\x00-\x1f\x7f]/.test(value[key]))) throw new Error(`Invalid ${key} in Boat config.`);
    }
    if (value.apiKey && ((await statSafe(configPath, 'file')).mode & 0o077)) throw new Error('Boat config contains a credential but is not private. Set its permissions to mode 0600 before use.');
    return value;
  }

  async function bindings() {
    if (!await checkParents(bindingsDir, true)) return [];
    if (!await statSafe(bindingsDir, 'directory', true)) return [];
    const values = [];
    for (const entry of await readdir(bindingsDir, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      const path = join(bindingsDir, entry.name);
      const value = validateBinding(await readJson(path), path);
      if (`${value.id}.json` !== entry.name) throw new Error(`Binding filename does not match its ID at ${path}.`);
      if (value.alias !== aliasFor(value.id, value.apiUrl, value.org)) throw new Error(`Binding alias belongs to a different state root at ${path}.`);
      values.push(value);
    }
    return values;
  }

  async function putBinding(binding) {
    validateBinding(binding, 'new binding');
    if (binding.alias !== aliasFor(binding.id, binding.apiUrl, binding.org)) throw new Error('Binding alias belongs to a different state root.');
    await directory(bindingsDir);
    await atomicWrite(join(bindingsDir, `${binding.id}.json`), `${JSON.stringify(binding, null, 2)}\n`);
  }

  async function removeBinding(binding) {
    const path = join(bindingsDir, `${binding.id}.json`);
    if (await statSafe(path, 'file', true)) { await unlink(path); await syncDirectory(bindingsDir); }
  }

  async function withLock(action) {
    const releases = [];
    try {
      await directory(stateDir);
      await directory(configDir);
      await directory(sshDir);
      const directories = [...new Set([stateDir, configDir, sshDir])].sort();
      for (const path of directories) releases.push(await acquireLock(join(path, '.mutation-lock')));
      return await action();
    } finally {
      for (const release of releases.reverse()) await release();
    }
  }

  async function profiles() {
    let value;
    try { value = JSON.parse(await run(herdr, ['machine', 'list', '--json'], env)); } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Herdr returned invalid JSON for machine list.');
      throw error;
    }
    if (!Array.isArray(value)) throw new Error('Herdr machine list must return a JSON array.');
    const ids = new Set();
    for (const item of value) {
      if (!item || typeof item.id !== 'string' || !item.id || /[\x00-\x1f\x7f]/.test(item.id) || typeof item.target !== 'string' || typeof item.session !== 'string' || typeof item.enabled !== 'boolean' || ids.has(item.id)) throw new Error('Herdr machine list returned an invalid or duplicate profile.');
      ids.add(item.id);
    }
    return value;
  }

  async function findProfile(binding, catalog) {
    catalog ??= await profiles();
    const recorded = binding.profileId === null ? null : catalog.find(item => item.id === binding.profileId);
    if (recorded) {
      if (recorded.target !== binding.alias || recorded.session !== binding.session) throw new Error(`Herdr profile ${recorded.id} no longer belongs to Boat sandbox ${binding.id}; refusing to modify it.`);
      return recorded;
    }
    const matches = catalog.filter(item => item.target === binding.alias && item.session === binding.session);
    if (matches.length > 1) throw new Error(`Multiple Herdr profiles target ${binding.alias}; refusing to append or guess ownership.`);
    if (matches.length === 1) {
      binding.profileId = matches[0].id;
      await putBinding(binding);
      return matches[0];
    }
    return null;
  }

  async function setEnabled(binding, enabled) {
    const profile = await findProfile(binding);
    if (profile && profile.enabled !== enabled) await run(herdr, ['machine', enabled ? 'enable' : 'disable', profile.id], env);
    return profile;
  }

  async function register(binding, label) {
    let profile = await findProfile(binding);
    if (!profile) {
      await run(herdr, ['machine', 'add', binding.alias, '--label', label, '--remote-session', binding.session], env, true);
      profile = await findProfile(binding);
      if (!profile) throw new Error(`Herdr did not save a profile for ${binding.id}; run sync ${binding.id} to reconcile.`);
    }
    if (binding.profileId !== profile.id) { binding.profileId = profile.id; await putBinding(binding); }
    await setEnabled(binding, true);
    return profile.id;
  }

  async function publicKey() {
    const privateStat = await statSafe(keyPath, 'file', true);
    const publicStat = await statSafe(`${keyPath}.pub`, 'file', true);
    if (Boolean(privateStat) !== Boolean(publicStat)) throw new Error(`Incomplete plugin SSH key at ${keyPath}; restore its matching pair before retrying.`);
    if (!privateStat) {
      const temp = join(stateDir, `.key-${randomUUID()}`);
      try {
        await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'herdr-boat-machines', '-f', temp], env);
        await statSafe(temp, 'file');
        await statSafe(`${temp}.pub`, 'file');
        await atomicWrite(keyPath, await readOwned(temp), { immutable: true });
        await atomicWrite(`${keyPath}.pub`, await readOwned(`${temp}.pub`), { immutable: true });
      } finally {
        await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await unlink(`${temp}.pub`).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
    await chmod(keyPath, 0o600);
    const key = (await readOwned(`${keyPath}.pub`)).toString('utf8').trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(key)) throw new Error('Invalid plugin-owned Ed25519 public key.');
    return key;
  }

  async function installInclude() {
    const main = join(home, '.ssh', 'config');
    const original = await readOwned(main, true);
    const include = `Include ${quote(join(sshDir, '*.conf'))}`;
    const prefix = Buffer.from(`${include}\nHost *\n`);
    if (original?.subarray(0, prefix.length).equals(prefix)) return;
    let remaining = original ?? Buffer.alloc(0);
    const lines = [];
    let offset = 0;
    while (offset < remaining.length) {
      const newline = remaining.indexOf(10, offset);
      const end = newline < 0 ? remaining.length : newline + 1;
      const line = remaining.subarray(offset, end);
      if (line.toString('utf8').replace(/\r?\n$/, '') !== include) lines.push(line);
      offset = end;
    }
    remaining = Buffer.concat(lines);
    await atomicWrite(main, Buffer.concat([prefix, remaining]), { expected: original });
  }

  async function configureSsh(binding, response) {
    const ssh = parseSsh(response);
    const generations = join(sshDir, 'generations');
    await directory(generations);
    const generation = join(generations, `${binding.id}-${randomUUID()}`);
    await directory(generation);
    const knownHosts = join(generation, 'known_hosts');
    await atomicWrite(knownHosts, `${binding.alias} ${ssh.hostKey}\n`, { immutable: true });
    const stanza = [
      `Host ${binding.alias}`,
      `  HostName ${ssh.hostname}`,
      `  Port ${ssh.port}`,
      `  User ${ssh.user}`,
      `  IdentityFile ${quote(keyPath)}`,
      '  IdentitiesOnly yes',
      '  StrictHostKeyChecking yes',
      `  HostKeyAlias ${binding.alias}`,
      `  UserKnownHostsFile ${quote(knownHosts)}`,
      '  GlobalKnownHostsFile /dev/null',
      '  KnownHostsCommand none',
      '  VerifyHostKeyDNS no',
      '  ForwardAgent no',
      '  UpdateHostKeys no',
      '  ControlMaster no',
      '  ControlPath none',
      '  ControlPersist no',
      '',
    ].join('\n');
    await atomicWrite(join(generation, 'config'), stanza, { immutable: true });
    await atomicWrite(join(sshDir, `${binding.alias}.conf`), stanza);
    await installInclude();
  }

  async function detach(binding) {
    const profile = await findProfile(binding);
    if (profile) await run(herdr, ['machine', 'remove', profile.id], env);
    const aliasConfig = join(sshDir, `${binding.alias}.conf`);
    if (await statSafe(aliasConfig, 'file', true)) { await unlink(aliasConfig); await syncDirectory(sshDir); }
    await removeBinding(binding);
  }

  return {
    paths: { configDir, stateDir },
    aliasFor,
    readConfig, bindings, putBinding, removeBinding, withLock, profiles, findProfile, setEnabled,
    register, publicKey, configureSsh, detach,
    async saveConfig(value) { await atomicWrite(configPath, `${JSON.stringify(value, null, 2)}\n`); },
  };
}

export { validateOperationId };
