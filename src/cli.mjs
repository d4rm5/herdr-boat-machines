#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManager } from './manager.mjs';
import { validateId, validateSize } from './boat.mjs';
import { runPane, formatResult, terminalText, warningsFor } from './pane.mjs';

const id = { key: 'id', label: 'Sandbox ID', required: true };
const name = { key: 'name', label: 'Name', required: true };
const size = { flag: 'size', key: 'size', label: 'Size, small/default/large/xlarge', type: 'value' };
const ttl = { flag: 'ttl', key: 'ttlSeconds', label: 'Auto-stop seconds, or never', type: 'ttl' };
const optionalName = { flag: 'name', key: 'name', label: 'Name', type: 'value' };
const confirmation = { flag: 'confirm', key: 'confirmation', type: 'value', required: true, hidden: true };

export const COMMANDS = {
  open: { description: 'Open the Boat machines pane in Herdr.', usage: 'open', menu: false },
  manage: { description: 'Manage machines in this terminal.', usage: 'manage', menu: false },
  list: { description: 'List cloud machines and retained local bindings.', usage: 'list' },
  info: { description: 'Show machine details.', usage: 'info ID', positionals: [id] },
  create: {
    description: 'Create a billable machine and add it to Herdr.',
    usage: 'create --name NAME [--size SIZE] [--ttl SECONDS | --no-auto-stop] [--from SNAPSHOT] [--environment NAME] [--no-env]',
    options: [
      { ...optionalName, required: true }, size, ttl,
      { flag: 'from', key: 'from', label: 'Saved snapshot, optional', type: 'value' },
      { flag: 'environment', key: 'environment', label: 'Environment, optional', type: 'value' },
      { flag: 'no-env', key: 'noEnv', label: 'Skip environment setup', type: 'boolean' },
    ],
  },
  adopt: { description: 'Connect an existing cloud machine to Herdr.', usage: 'adopt ID', positionals: [id] },
  sync: { description: 'Refresh one binding, or all managed machines.', usage: 'sync [ID]', positionals: [{ ...id, required: false }] },
  stop: { description: 'Stop a machine after typed confirmation.', usage: 'stop ID --confirm ID', positionals: [id], options: [confirmation] },
  resume: { description: 'Resume a machine and refresh its existing Herdr profile.', usage: 'resume ID [--size SIZE] [--ttl SECONDS | --no-auto-stop]', positionals: [id], options: [size, ttl] },
  fork: { description: 'Create a new billable machine from an existing machine.', usage: 'fork ID [--name NAME] [--size SIZE] [--ttl SECONDS | --no-auto-stop]', positionals: [id], options: [optionalName, size, ttl] },
  recover: { description: 'Recover an unhealthy machine.', usage: 'recover ID', positionals: [id] },
  extend: { description: 'Change the machine auto-stop policy.', usage: 'extend ID (--ttl SECONDS | --no-auto-stop)', positionals: [id], options: [{ ...ttl, required: true }] },
  snapshot: { description: 'Save a snapshot, replacing the same saved name.', usage: 'snapshot ID NAME --confirm NAME', positionals: [id, name], options: [confirmation] },
  snapshots: { description: 'List saved snapshots.', usage: 'snapshots' },
  rename: { description: 'Rename a cloud machine.', usage: 'rename ID NAME', positionals: [id, name] },
  forget: { description: 'Remove the local binding without deleting the cloud machine.', usage: 'forget ID', positionals: [id] },
  delete: { description: 'Permanently delete a cloud machine.', usage: 'delete ID --confirm ID', positionals: [id], options: [confirmation] },
  deletion: { description: 'Check a deletion operation.', usage: 'deletion OPID', positionals: [{ key: 'operationId', label: 'Deletion operation ID', required: true }] },
  setup: { description: 'Store an API key privately from standard input.', usage: 'setup --key-stdin', options: [{ flag: 'key-stdin', key: 'keyStdin', type: 'boolean', required: true }], secure: true },
};

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`${label} must be nonempty text without terminal control characters.`);
  }
  return value;
}

export function parseArgs(argv) {
  const [kind = 'help', ...args] = argv;
  if (kind === 'help' || kind === '--help' || kind === '-h') {
    if (args.length > 1 || (args[0] && !Object.hasOwn(COMMANDS, args[0]))) throw new Error('Use help [COMMAND].');
    return { kind: 'help', command: args[0] };
  }
  if (!Object.hasOwn(COMMANDS, kind)) throw new Error(`Unknown command ${terminalText(kind)}. Use help.`);
  const spec = COMMANDS[kind];
  const command = { kind };
  const positional = [];
  const seen = new Set();
  const options = new Map((spec.options ?? []).map(option => [`--${option.flag}`, option]));
  if (options.has('--ttl')) options.set('--no-auto-stop', { flag: 'no-auto-stop', key: 'ttlSeconds', type: 'no-auto-stop' });
  let endOptions = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!endOptions && token === '--') { endOptions = true; continue; }
    if (!endOptions && (token === '--help' || token === '-h')) { help = true; continue; }
    if (!endOptions && token.startsWith('-')) {
      const equals = token.indexOf('=');
      const flag = equals < 0 ? token : token.slice(0, equals);
      const option = options.get(flag);
      if (!option) throw new Error(`Unknown flag ${terminalText(flag)} for ${kind}.`);
      if (seen.has(option.key)) throw new Error(`Repeated or conflicting option ${flag}.`);
      seen.add(option.key);
      if (option.type === 'boolean' || option.type === 'no-auto-stop') {
        if (equals >= 0) throw new Error(`${flag} does not take a value.`);
        command[option.key] = option.type === 'no-auto-stop' ? null : true;
      } else {
        const value = equals < 0 ? args[++index] : token.slice(equals + 1);
        if (value === undefined || (equals < 0 && value.startsWith('-'))) throw new Error(`${flag} requires a value.`);
        command[option.key] = nonempty(value, flag);
      }
    } else {
      positional.push(token);
    }
  }
  if (positional.length > (spec.positionals?.length ?? 0)) throw new Error(`Too many arguments. Use ${spec.usage}.`);
  for (const [index, field] of (spec.positionals ?? []).entries()) {
    if (positional[index] !== undefined) command[field.key] = nonempty(positional[index], field.label);
    else if (field.required && !help) throw new Error(`${field.label} is required. Use ${spec.usage}.`);
  }
  if (help) return { kind: 'help', command: kind };
  for (const option of spec.options ?? []) {
    if (option.required && !seen.has(option.key)) throw new Error(`--${option.flag} is required. Use ${spec.usage}.`);
  }
  if (command.id !== undefined) validateId(command.id);
  if (command.size !== undefined) validateSize(command.size);
  if (typeof command.ttlSeconds === 'string') {
    if (!/^[1-9][0-9]*$/u.test(command.ttlSeconds) || !Number.isSafeInteger(Number(command.ttlSeconds))) {
      throw new Error('--ttl must be a positive safe integer number of seconds.');
    }
    command.ttlSeconds = Number(command.ttlSeconds);
  }
  if (command.noEnv && command.environment !== undefined) throw new Error('--environment and --no-env cannot be combined.');
  if ((kind === 'stop' || kind === 'delete') && command.confirmation !== command.id) throw new Error(`--confirm must exactly match ${command.id}.`);
  if (kind === 'snapshot' && command.confirmation !== command.name) throw new Error('--confirm must exactly match the saved snapshot name.');
  return command;
}

export function helpText(command) {
  if (command) {
    const spec = COMMANDS[command];
    return `Usage: node src/cli.mjs ${spec.usage}\n\n${spec.description}\n${warningsFor(command).map(warning => `\nWarning: ${warning}`).join('')}\n`;
  }
  return `Boat machines for Herdr\n\nUsage: node src/cli.mjs COMMAND [OPTIONS]\n\n${Object.values(COMMANDS).map(spec => `  ${spec.usage}\n    ${spec.description}`).join('\n')}\n  help [COMMAND]\n    Show this help or help for one command.\n\nSIZE is small, default, large, or xlarge. TTL is positive seconds.\nCreate and fork default to 3600 seconds. Resume keeps the current TTL unless supplied.\nUse --no-auto-stop instead of --ttl to disable auto-stop. Billing continues while running.\nSetup accepts a key through piped standard input, never an argument.\nUse manage for secure interactive key entry.\n`;
}

async function readKey(input) {
  if (input.isTTY) throw new Error('setup --key-stdin requires piped input to avoid echoing the key. Use manage for secure entry.');
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 65536) throw new Error('API key input is too long.');
    chunks.push(buffer);
  }
  return nonempty(Buffer.concat(chunks).toString('utf8').trim(), 'API key');
}

async function openPane(env) {
  await new Promise((done, reject) => {
    const child = spawn(env.HERDR_BIN_PATH || 'herdr', ['plugin', 'pane', 'open', '--plugin', 'boat.machines', '--entrypoint', 'manager'], { env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(signal ? `Herdr exited after ${signal}.` : `Herdr exited with status ${code}.`)));
  });
}

export async function main(argv = process.argv.slice(2), { env = process.env, input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  let apiKey;
  try {
    const command = parseArgs(argv);
    if (command.kind === 'help') { output.write(helpText(command.command)); return 0; }
    if (command.kind === 'open') { await openPane(env); return 0; }
    if (command.kind === 'setup') apiKey = await readKey(input);
    const manager = await createManager({ env });
    if (command.kind === 'manage') {
      await runPane({ manager, commands: COMMANDS, parseArgs, helpText, input, output, errorOutput });
      return 0;
    }
    for (const warning of warningsFor(command.kind)) errorOutput.write(`Warning: ${warning}\n`);
    const result = command.kind === 'list' ? await manager.list() : await manager.execute(command.kind === 'setup' ? { kind: 'setup', apiKey } : command);
    output.write(command.kind === 'setup' ? 'API key saved privately.\n' : `${formatResult(result)}\n`);
    return 0;
  } catch (error) {
    let message = String(error?.message ?? error);
    if (apiKey) message = message.split(apiKey).join('[redacted]');
    errorOutput.write(`Error: ${terminalText(message)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
