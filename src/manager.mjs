import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BoatClient, validateId, validateSize } from './boat.mjs';
import { openLocal, validateOperationId } from './local.mjs';

const phases = Object.freeze({
  init: 'starting', provisioning: 'starting', provisioned: 'starting', cloning: 'starting',
  ready: 'available', idle: 'available', running: 'available',
  archiving: 'stopping', archived: 'stopped', error: 'failed', cancelled: 'failed',
});
const stopWarning = 'Stopping ends running programs. Zero-data-retention or disabled snapshots may erase the disk.';
const deadlineMs = 300000;
const commandFields = Object.freeze({
  create: ['name', 'size', 'ttlSeconds', 'from', 'environment', 'noEnv'],
  adopt: ['id'], sync: ['id'], resume: ['id', 'size', 'ttlSeconds'],
  fork: ['id', 'name', 'size', 'ttlSeconds'], recover: ['id'], forget: ['id'], info: ['id'],
  stop: ['id', 'confirmation'], delete: ['id', 'confirmation'], extend: ['id', 'ttlSeconds'],
  rename: ['id', 'name'], snapshot: ['id', 'name', 'confirmation'], snapshots: [],
  deletion: ['operationId'], setup: ['apiKey'],
});

function text(value, label, limit = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error(`${label} must be nonempty text without control characters, at most ${limit} characters.`);
  return value;
}

function ttl(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw new Error('TTL must be a positive safe integer number of seconds, or null to disable auto-stop.');
}

function validateCommand(command) {
  if (!command || Array.isArray(command) || typeof command !== 'object' || !Object.hasOwn(commandFields, command.kind)) throw new Error('Unknown Boat manager command.');
  const allowed = new Set(['kind', ...commandFields[command.kind]]);
  for (const field of Object.keys(command)) if (!allowed.has(field)) throw new Error(`Unknown ${command.kind} field ${field}.`);
  if (allowed.has('id') && (command.kind !== 'sync' || command.id !== undefined)) validateId(command.id);
  if (command.size !== undefined) validateSize(command.size);
  if (Object.hasOwn(command, 'ttlSeconds')) ttl(command.ttlSeconds);
  if (command.kind === 'extend' && !Object.hasOwn(command, 'ttlSeconds')) throw new Error('Extend requires ttlSeconds.');
  if (['create', 'rename', 'snapshot'].includes(command.kind) || command.name !== undefined) text(command.name, 'Name');
  if (command.kind === 'snapshot' && ['.', '..'].includes(command.name)) throw new Error('Saved snapshot name cannot be a URL dot segment.');
  if (command.from !== undefined) text(command.from, 'Snapshot name');
  if (command.environment !== undefined) text(command.environment, 'Environment');
  if (command.noEnv !== undefined && typeof command.noEnv !== 'boolean') throw new Error('noEnv must be boolean.');
  if (command.kind === 'setup') text(command.apiKey, 'API key', 8192);
  if (command.kind === 'deletion') validateOperationId(command.operationId);
  if (['stop', 'delete'].includes(command.kind) && command.confirmation !== command.id) throw new Error(`${command.kind === 'stop' ? `${stopWarning} ` : 'Deletion permanently erases sandbox data. '}Type the exact sandbox ID ${command.id} as confirmation.`);
  if (command.kind === 'snapshot' && command.confirmation !== command.name) throw new Error('Saving can overwrite an existing saved snapshot, even if a preflight found no match. Confirm with the exact snapshot name.');
  return { ...command };
}

function scoped(binding, client) {
  if (binding.apiUrl !== client.apiUrl || binding.org !== (client.org ?? null)) throw new Error(`Sandbox ${binding.id} belongs to a different Boat API URL or organization. Restore its original scope before operating on its binding.`);
  return binding;
}

function operation(value, expectedId, expectedTarget) {
  if (!value || typeof value !== 'object') throw new Error('Boat returned an invalid deletion operation.');
  validateOperationId(value.id);
  validateId(value.targetId);
  if (typeof value.status !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.status)) throw new Error('Boat returned an invalid deletion operation status.');
  if (expectedId && value.id !== expectedId) throw new Error('Boat returned a different deletion operation ID.');
  if (expectedTarget && value.targetId !== expectedTarget) throw new Error('Boat deletion operation refers to a different sandbox.');
  return value;
}

function snapshot(value, expectedName) {
  if (!value || !['ready', 'saving', 'failed'].includes(value.status) || (value.name !== undefined && value.name !== expectedName)) throw new Error('Boat returned an invalid saved snapshot status.');
  return value;
}

function safeMessage(value, keys) {
  let message = String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  for (const key of keys) if (typeof key === 'string' && key) message = message.replaceAll(key, '[redacted]');
  return message;
}

function safeResult(value, keys) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (key === 'desktopUrl') return undefined;
    return typeof item === 'string' ? safeMessage(item, keys) : item;
  }));
}

export async function createManager({ env = process.env } = {}) {
  const local = await openLocal({ env });

  async function context(explicitKey) {
    const config = await local.readConfig();
    const apiKey = explicitKey ?? env.BOAT_API_KEY ?? config.apiKey;
    const apiUrl = env.BOAT_API_URL ?? config.apiUrl ?? 'https://boat.dev/api/v1';
    const org = env.BOAT_ORG ?? config.org;
    if (org !== undefined) text(org, 'Organization');
    const client = new BoatClient({ apiKey, apiUrl, org });
    if (explicitKey === undefined && !env.BOAT_API_KEY && config.apiKey) {
      const storedOrigin = new URL(config.apiUrl ?? 'https://boat.dev/api/v1').origin;
      const selected = new URL(client.apiUrl);
      if (selected.origin !== storedOrigin) throw new Error('An API origin override requires an explicit BOAT_API_KEY or a key explicitly saved for that origin. The stored credential will not be sent to a different origin.');
    }
    return { client, config, keys: [apiKey, config.apiKey, explicitKey] };
  }

  function newBinding(id, client) {
    return { version: 1, id, alias: local.aliasFor(id, client.apiUrl, client.org ?? null), profileId: null, session: 'default', apiUrl: client.apiUrl, org: client.org ?? null };
  }

  async function ensureBinding(id, client) {
    const existing = (await local.bindings()).find(item => item.id === id);
    if (existing) return scoped(existing, client);
    const binding = newBinding(id, client);
    await local.putBinding(binding);
    return binding;
  }

  async function connect(binding, sandbox, client) {
    if (binding.deletionOperationId) throw new Error(`Sandbox ${binding.id} has pending deletion ${binding.deletionOperationId}. Query that operation before connecting.`);
    await local.setEnabled(binding, false);
    const publicKey = await local.publicKey();
    const response = await client.request('POST', `/sandboxes/${binding.id}/sshkey`, { key: publicKey });
    await local.configureSsh(binding, response);
    const profileId = await local.register(binding, text(sandbox.name ?? binding.id, 'Boat sandbox name'));
    return { profileId, enabled: true };
  }

  async function syncOne(binding, client) {
    scoped(binding, client);
    if (binding.deletionOperationId) {
      const pending = operation((await client.request('GET', `/deletion-operations/${encodeURIComponent(binding.deletionOperationId)}`)).operation, binding.deletionOperationId, binding.id);
      if (pending.status === 'completed') {
        await local.detach(binding);
        return { kind: 'sync', id: binding.id, state: 'missing', deletionOperationId: pending.id, status: 'completed', message: 'Deletion completed. Removed this plugin\'s local profile and binding.' };
      }
      await local.setEnabled(binding, false);
      return { kind: 'sync', id: binding.id, deletionOperationId: pending.id, status: pending.status, message: `Deletion ${pending.id} is ${pending.status}. Local binding is retained and disabled.` };
    }
    let sandbox;
    try { sandbox = await client.get(binding.id); } catch (error) {
      if (error.status !== 404) throw error;
      await local.setEnabled(binding, false);
      return { kind: 'sync', id: binding.id, state: 'missing', message: 'Sandbox is missing from Boat. Local binding remains disabled until explicit forget or completed deletion.' };
    }
    const phase = phases[sandbox.state] ?? 'unknown';
    if (phase === 'available') {
      const connection = await connect(binding, sandbox, client);
      return { kind: 'sync', id: binding.id, state: sandbox.state, ...connection, message: 'Boat and pinned SSH are ready. Connecting in the Herdr sidebar starts its installed remote server; a headless machine bridge does not.' };
    }
    if (phase !== 'unknown') await local.setEnabled(binding, false);
    return { kind: 'sync', id: binding.id, state: sandbox.state, message: phase === 'unknown' ? `Unknown Boat state ${sandbox.state}. No availability or connection changes were assumed.` : `Boat state is ${sandbox.state}. The local binding is retained and its profile is disabled.` };
  }

  async function list() {
    const { client, keys } = await context();
    try {
      const [cloud, bindings] = await Promise.all([client.list(), local.bindings()]);
      const catalog = bindings.length ? await local.profiles() : [];
      const byId = new Map(cloud.map(item => [item.id, item]));
      for (const binding of bindings) if (!byId.has(binding.id)) byId.set(binding.id, { id: binding.id, name: binding.id, state: 'missing' });
      const mapped = new Map(bindings.map(item => [item.id, item]));
      return [...byId.values()].map(sandbox => {
        const binding = mapped.get(sandbox.id);
        let profile;
        let error;
        if (binding) {
          try {
            scoped(binding, client);
            const recorded = binding.profileId ? catalog.find(item => item.id === binding.profileId) : null;
            if (recorded && (recorded.target !== binding.alias || recorded.session !== binding.session)) throw new Error('Recorded Herdr profile has changed target or session; it will not be modified.');
            const matches = recorded ? [recorded] : catalog.filter(item => item.target === binding.alias && item.session === binding.session);
            if (matches.length > 1) throw new Error('Multiple Herdr profiles have this exact target and session.');
            profile = matches[0];
          } catch (cause) { error = safeMessage(cause.message, keys); }
        }
        const row = { id: sandbox.id, name: safeMessage(sandbox.name ?? sandbox.id, keys), state: sandbox.state, type: sandbox.type ?? null, archiveAfter: sandbox.archiveAfter ?? null, managed: Boolean(binding), profileId: profile?.id ?? binding?.profileId ?? null, enabled: profile?.enabled ?? false };
        if (error || sandbox.error) row.error = error ?? safeMessage(typeof sandbox.error === 'string' ? sandbox.error : JSON.stringify(sandbox.error), keys);
        if (binding?.deletionOperationId) row.deletionOperationId = binding.deletionOperationId;
        return safeResult(row, keys);
      });
    } catch (error) {
      error.message = safeMessage(error.message, keys);
      throw error;
    }
  }

  async function execute(input) {
    const command = validateCommand(input);
    let knownId = command.id;
    let knownOperationId = command.operationId;
    let creationSubmitted = false;
    let createdIdKnown = false;
    let keys = [env.BOAT_API_KEY, command.apiKey];
    try {
      if (command.kind === 'setup') {
        return await local.withLock(async () => {
          const { client, config } = await context(command.apiKey);
          await local.saveConfig({ ...config, apiKey: command.apiKey, apiUrl: client.apiUrl, ...(client.org === undefined ? {} : { org: client.org }) });
          return { kind: 'setup', message: 'Explicit Boat API key saved securely. No cloud resource was created.' };
        });
      }
      if (command.kind === 'forget') {
        return await local.withLock(async () => {
          const binding = (await local.bindings()).find(item => item.id === command.id);
          if (!binding) throw new Error(`Sandbox ${command.id} has no local binding to forget.`);
          if (binding.deletionOperationId) {
            knownOperationId = binding.deletionOperationId;
            throw new Error(`Sandbox ${command.id} has unresolved deletion ${binding.deletionOperationId}. Query deletion status before forgetting its retained identity.`);
          }
          await local.detach(binding);
          return { kind: 'forget', id: command.id, message: "Removed only this plugin's local profile and binding. Boat resources, remote programs and billing were not changed." };
        });
      }
      const current = await context();
      const { client } = current;
      keys = current.keys;
      const perform = async () => {
        const bindings = await local.bindings();
        const binding = command.id ? bindings.find(item => item.id === command.id) : null;
        if (binding) scoped(binding, client);
        if (binding?.deletionOperationId) knownOperationId = binding.deletionOperationId;
        const path = command.id ? `/sandboxes/${command.id}` : null;
        switch (command.kind) {
          case 'snapshots':
            return { kind: 'snapshots', snapshots: await client.savedSnapshots(), message: 'Saved snapshots retrieved from Boat.' };
          case 'info': {
            let sandbox;
            try { sandbox = await client.get(command.id); } catch (error) {
              if (error.status !== 404 || !binding) throw error;
              sandbox = { id: command.id, name: command.id, state: 'missing' };
            }
            const result = { kind: 'info', id: command.id, sandbox, managed: Boolean(binding), profileId: binding?.profileId ?? null, message: `Boat state is ${sandbox.state}.` };
            if (binding?.deletionOperationId) {
              result.deletionOperationId = binding.deletionOperationId;
              result.deletion = operation((await client.request('GET', `/deletion-operations/${encodeURIComponent(binding.deletionOperationId)}`)).operation, binding.deletionOperationId, command.id);
            }
            return result;
          }
          case 'create':
          case 'fork': {
            let response;
            if (command.kind === 'create') {
              const body = { name: command.name, type: command.size ?? 'default', ttlSeconds: Object.hasOwn(command, 'ttlSeconds') ? command.ttlSeconds : 3600 };
              for (const field of ['from', 'environment', 'noEnv']) if (command[field] !== undefined) body[field] = command[field];
              creationSubmitted = true;
              response = await client.request('POST', '/sandboxes', body, { 'Idempotency-Key': randomUUID() });
              knownId = validateId(response.sandbox?.id);
            } else {
              const body = { ttlSeconds: Object.hasOwn(command, 'ttlSeconds') ? command.ttlSeconds : 3600 };
              if (command.size !== undefined) body.type = command.size;
              creationSubmitted = true;
              response = await client.request('POST', `${path}/fork`, body, { 'Idempotency-Key': randomUUID() });
              knownId = validateId(response.id ?? response.sandbox?.id);
              if (knownId === command.id) throw new Error(`Boat fork returned source ID ${command.id}; refusing to overwrite its binding.`);
            }
            createdIdKnown = true;
            const created = newBinding(knownId, client);
            if (bindings.some(item => item.id === knownId)) throw new Error(`Boat returned already-managed sandbox ${knownId}; refusing to overwrite its binding.`);
            await local.putBinding(created);
            process.stderr.write(`Boat sandbox retained: ${knownId}\n`);
            if (command.kind === 'fork' && command.name !== undefined) await client.request('PATCH', `/sandboxes/${knownId}`, { name: command.name });
            const sandbox = await client.wait(knownId, item => phases[item.state] === 'available');
            const connection = await connect(created, sandbox, client);
            return { kind: command.kind, id: knownId, state: sandbox.state, ...connection, message: 'Sandbox retained in Boat and pinned SSH is ready. Connect through the Herdr sidebar to start its installed remote server.' };
          }
          case 'adopt': {
            const sandbox = await client.get(command.id);
            if (!Object.hasOwn(phases, sandbox.state)) throw new Error(`Sandbox ${command.id} has unknown Boat state ${sandbox.state}. Adoption requires a recognized lifecycle state.`);
            const adopted = binding ?? await ensureBinding(command.id, client);
            if (phases[sandbox.state] === 'available') {
              const connection = await connect(adopted, sandbox, client);
              return { kind: 'adopt', id: command.id, state: sandbox.state, ...connection, message: 'Existing Boat sandbox adopted. Connect through the Herdr sidebar to start its installed remote server.' };
            }
            const result = await syncOne(adopted, client);
            return { ...result, kind: 'adopt' };
          }
          case 'sync': {
            if (command.id) {
              if (!binding) throw new Error(`Sandbox ${command.id} is not managed. Adopt it before syncing.`);
              return syncOne(binding, client);
            }
            for (const item of bindings) scoped(item, client);
            const results = [];
            for (const item of bindings) {
              try { results.push(await syncOne(item, client)); } catch (error) {
                error.message = `Sync failed for ${item.id}. ${error.message}`;
                error.id = item.id;
                knownOperationId = item.deletionOperationId;
                throw error;
              }
            }
            return { kind: 'sync', results, message: `Synchronized ${results.length} managed sandbox bindings.` };
          }
          case 'resume':
          case 'recover': {
            if (binding?.deletionOperationId) throw new Error(`Sandbox ${command.id} has pending deletion ${binding.deletionOperationId}.`);
            const managed = binding ?? await ensureBinding(command.id, client);
            const body = {};
            if (command.size !== undefined) body.type = command.size;
            if (Object.hasOwn(command, 'ttlSeconds')) body.ttlSeconds = command.ttlSeconds;
            if (command.kind === 'resume') await client.request('POST', `${path}/resume`, body);
            else await client.request('POST', `${path}/recover`);
            const sandbox = await client.wait(command.id, item => phases[item.state] === 'available' && (command.kind !== 'recover' || item.health === 'ok'));
            const connection = await connect(managed, sandbox, client);
            return { kind: command.kind, id: command.id, state: sandbox.state, ...connection, message: 'Boat and pinned SSH are ready. Connect through the Herdr sidebar to start its installed remote server. A headless machine bridge does not start it.' };
          }
          case 'stop': {
            process.stderr.write(`${stopWarning}\n`);
            const accepted = await client.request('POST', `${path}/stop`, {});
            if (binding && (accepted.status === 'archiving' || ['archiving', 'archived'].includes(accepted.sandbox?.state))) await local.setEnabled(binding, false);
            const deadline = Date.now() + deadlineMs;
            let latest;
            do {
              latest = await client.get(command.id);
              const status = latest.stop?.status;
              if (['failed', 'failing', 'superseded', 'cancelled'].includes(status)) throw new Error(`Stop for ${command.id} is ${status}, not completed. No force-stop was attempted.`);
              if (['error', 'cancelled'].includes(latest.state)) throw new Error(`Stop for ${command.id} reached ${latest.state}, not completed.`);
              if (binding && (latest.state === 'archiving' || latest.state === 'archived')) await local.setEnabled(binding, false);
              if (latest.state === 'archived' && (status === undefined || status === 'completed')) return { kind: 'stop', id: command.id, state: latest.state, message: `${stopWarning} Boat reports stop completed.` };
              await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
            } while (Date.now() < deadline);
            throw new Error(`Stop for ${command.id} is still pending. Last state ${latest?.state ?? 'unknown'}. Inspect info before taking further action. No force-stop was attempted.`);
          }
          case 'extend':
            await client.request('PATCH', path, { ttlSeconds: command.ttlSeconds });
            return { kind: 'extend', id: command.id, ttlSeconds: command.ttlSeconds, message: command.ttlSeconds === null ? 'Auto-stop disabled. The sandbox may continue billing until explicitly stopped.' : `Auto-stop set to ${command.ttlSeconds} seconds from now, not added to its previous deadline.` };
          case 'rename':
            await client.request('PATCH', path, { name: command.name });
            return { kind: 'rename', id: command.id, name: command.name, message: 'Boat sandbox renamed. Its stable ID and existing Herdr profile are unchanged.' };
          case 'snapshot': {
            process.stderr.write('Saving a snapshot can replace an existing saved snapshot with the same name.\n');
            const response = await client.request('POST', '/saved-snapshots', { sandboxId: command.id, name: command.name });
            let saved = snapshot(response.snapshot, command.name);
            const deadline = Date.now() + deadlineMs;
            while (saved.status === 'saving' && Date.now() < deadline) {
              await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
              saved = snapshot((await client.request('GET', `/saved-snapshots/${encodeURIComponent(command.name)}`)).snapshot, command.name);
            }
            if (saved.status === 'failed') throw new Error(`Saved snapshot ${command.name} from ${command.id} failed.`);
            if (saved.status !== 'ready') return { kind: 'snapshot', id: command.id, name: command.name, status: 'saving', message: 'Snapshot is still saving. Query saved snapshots before submitting another save.' };
            return { kind: 'snapshot', id: command.id, name: command.name, status: saved.status, message: 'Boat reports the saved snapshot is ready.' };
          }
          case 'delete': {
            const managed = binding ?? await ensureBinding(command.id, client);
            let pending;
            if (managed.deletionOperationId) pending = operation((await client.request('GET', `/deletion-operations/${encodeURIComponent(managed.deletionOperationId)}`)).operation, managed.deletionOperationId, command.id);
            else {
              const response = await client.request('DELETE', path, undefined, { 'X-Ascii-Confirm-Delete': command.id });
              pending = operation(response.operation, undefined, command.id);
              knownOperationId = pending.id;
              managed.deletionOperationId = pending.id;
              await local.putBinding(managed);
            }
            knownOperationId = pending.id;
            await local.setEnabled(managed, false);
            const deadline = Date.now() + deadlineMs;
            while (!['completed', 'failed', 'cancelled', 'superseded'].includes(pending.status) && Date.now() < deadline) {
              await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
              pending = operation((await client.request('GET', `/deletion-operations/${encodeURIComponent(pending.id)}`)).operation, pending.id, command.id);
            }
            if (pending.status === 'completed') {
              await local.detach(managed);
              return { kind: 'delete', id: command.id, deletionOperationId: pending.id, status: 'completed', message: 'Boat reports permanent deletion completed. Removed this plugin\'s local profile and binding.' };
            }
            return { kind: 'delete', id: command.id, deletionOperationId: pending.id, status: pending.status, message: `Deletion ${pending.id} is ${pending.status}, not completed. Its local binding and operation ID are retained. Query deletion ${pending.id} for status.` };
          }
          case 'deletion': {
            const pending = operation((await client.request('GET', `/deletion-operations/${encodeURIComponent(command.operationId)}`)).operation, command.operationId);
            knownId = pending.targetId;
            const managed = bindings.find(item => item.deletionOperationId === pending.id);
            if (managed) {
              scoped(managed, client);
              if (managed.id !== pending.targetId) throw new Error('Retained deletion operation target no longer matches its binding.');
              if (pending.status === 'completed') await local.detach(managed);
              else await local.setEnabled(managed, false);
            }
            return { kind: 'deletion', id: pending.targetId, deletionOperationId: pending.id, status: pending.status, operation: pending, message: pending.status === 'completed' ? 'Boat reports deletion completed. Any matching owned local binding has been removed.' : `Deletion is ${pending.status}, not completed. Any matching local binding remains retained.` };
          }
          default:
            throw new Error('Unsupported manager command.');
        }
      };
      const result = ['snapshots', 'info'].includes(command.kind) ? await perform() : await local.withLock(perform);
      return safeResult(result, keys);
    } catch (error) {
      if (knownId && !error.id) error.id = knownId;
      if (knownOperationId) {
        error.deletionOperationId = knownOperationId;
        if (!String(error.message).includes(knownOperationId)) error.message += ` Deletion operation ${knownOperationId} is retained for status checks.`;
      }
      if (error.id) {
        error.resourceIds = [...new Set([...(error.resourceIds ?? []), error.id])];
        if (!String(error.message).includes(error.id)) error.message = `Sandbox ${error.id}. ${error.message}`;
      }
      if (creationSubmitted && ['create', 'fork'].includes(command.kind)) {
        error.message += createdIdKnown
          ? ` The cloud resource was not rolled back. Use info ${knownId} and sync ${knownId} to reconcile local setup.`
          : ' The cloud outcome may be unknown. Do not automatically repeat creation; list Boat sandboxes and adopt the exact ID if one was created.';
      }
      error.message = safeMessage(error.message, keys);
      throw error;
    }
  }

  return { list, execute, paths: local.paths };
}
