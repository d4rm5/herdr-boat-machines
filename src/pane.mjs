import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

export function terminalText(value) {
  return stripVTControlCharacters(String(value)).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ');
}

export function formatResult(value) {
  const json = JSON.stringify(value, (_key, item) => typeof item === 'string' ? terminalText(item) : item, 2) ?? 'null';
  return json.replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const WARNINGS = {
  create: ['Creating a machine starts cloud billing. Auto-stop defaults to one hour unless changed.'],
  resume: ['Resuming a machine starts cloud billing. Its existing auto-stop policy remains unless changed.'],
  fork: ['Forking creates a separate billable machine and leaves the source unchanged. Auto-stop defaults to one hour unless changed.'],
  stop: ['Stopping ends running programs. ZDR or disabled snapshots may erase the machine disk. There is no force-stop fallback.'],
  extend: ['Disabling or extending auto-stop can increase cloud charges.'],
  snapshot: ['A saved snapshot with the same name is replaced. The old snapshot cannot be restored by this plugin.'],
  forget: ['Forgetting only removes local management and the owned Herdr profile. The cloud machine is not deleted and may keep billing.'],
  delete: ['Deletion permanently destroys the cloud machine. It cannot be undone. Completion may be asynchronous.'],
};

export function warningsFor(kind) {
  return WARNINGS[kind] ?? [];
}

export async function runPane({ manager, commands, parseArgs, helpText, input = process.stdin, output = process.stdout, errorOutput = process.stderr }) {
  let readline;
  let stopped = false;
  let releasing = false;
  let pendingAnswer;
  let currentSecret;
  const entries = Object.entries(commands).filter(([, spec]) => spec.menu !== false);

  function exit() {
    stopped = true;
    if (pendingAnswer) {
      const answer = pendingAnswer;
      pendingAnswer = undefined;
      answer(null);
    }
    readline?.close();
  }

  function release() {
    if (!readline) return;
    releasing = true;
    readline.close();
    readline = undefined;
    input.pause();
    releasing = false;
  }

  function open(secret = false) {
    let target = output;
    if (secret) {
      target = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      target.columns = output.columns;
    }
    readline = createInterface({ input, output: target, terminal: Boolean(input.isTTY), historySize: 0 });
    readline.on('SIGINT', exit);
    readline.on('close', () => {
      if (!releasing) exit();
    });
  }

  async function ask(prompt, { secret = false } = {}) {
    if (stopped) return null;
    if (secret) {
      release();
      if (!input.isTTY) throw new Error('Secure entry needs a terminal. Pipe the key to node src/cli.mjs setup --key-stdin instead.');
      output.write(prompt);
      open(true);
    } else if (!readline) {
      open();
    }
    const answer = await new Promise(done => {
      pendingAnswer = done;
      readline.question(secret ? '' : prompt, value => {
        pendingAnswer = undefined;
        done(value);
      });
    });
    if (secret) {
      release();
      output.write('\n');
    }
    return answer;
  }

  async function collect(kind, spec) {
    if (spec.secure) {
      output.write('The API key will not be echoed. It is stored only in the private plugin config.\n');
      const key = await ask('Boat API key: ', { secret: true });
      if (key === null) return null;
      currentSecret = key.trim();
      if (!currentSecret || /[\u0000-\u001f\u007f-\u009f]/u.test(currentSecret)) throw new Error('API key must be nonempty text without control characters.');
      return { kind: 'setup', apiKey: currentSecret };
    }
    const args = [kind];
    const positionals = [];
    for (const field of spec.positionals ?? []) {
      const value = await ask(`${field.label}${field.required ? '' : ', blank for all managed machines'}: `);
      if (value === null) return null;
      positionals.push(value.trim());
    }
    for (const option of spec.options ?? []) {
      if (option.hidden) continue;
      if (option.type === 'boolean') {
        const answer = await ask(`${option.label}? [y/N]: `);
        if (answer === null) return null;
        if (!/^(?:y|yes|n|no)?$/iu.test(answer.trim())) throw new Error('Answer yes or no.');
        if (/^(?:y|yes)$/iu.test(answer.trim())) args.push(`--${option.flag}`);
      } else {
        const answer = await ask(`${option.label}${option.required ? '' : ', blank to keep the default'}: `);
        if (answer === null) return null;
        const value = answer.trim();
        if (value) {
          if (option.type === 'ttl' && value.toLowerCase() === 'never') args.push('--no-auto-stop');
          else args.push(`--${option.flag}`, value);
        }
      }
    }
    for (const warning of warningsFor(kind)) output.write(`Warning: ${warning}\n`);
    if (kind === 'stop' || kind === 'delete' || kind === 'snapshot') {
      const expected = kind === 'snapshot' ? positionals[1] : positionals[0];
      const answer = await ask(`Type ${terminalText(expected)} to confirm, or leave blank to cancel: `);
      if (answer === null) return null;
      if (answer !== expected) { output.write('Cancelled. Nothing changed.\n'); return null; }
      args.push('--confirm', answer);
    }
    if (kind === 'forget') {
      const answer = await ask(`Type ${terminalText(positionals[0])} to forget its local binding: `);
      if (answer === null) return null;
      if (answer !== positionals[0]) { output.write('Cancelled. Nothing changed.\n'); return null; }
    }
    args.push('--', ...positionals.filter(value => value !== ''));
    return parseArgs(args);
  }

  process.on('SIGINT', exit);
  try {
    output.write('Boat machines\nCloud resources may keep billing after this pane closes.\n');
    while (!stopped) {
      output.write(`\n${entries.map(([kind, spec], index) => `  ${index + 1}. ${kind}  ${spec.description}`).join('\n')}\n  h. Help\n  q. Exit\n`);
      const selection = await ask('Choose a number or command: ');
      if (selection === null) break;
      const choice = selection.trim();
      if (/^(?:q|quit|exit)$/iu.test(choice)) break;
      if (/^(?:h|help|\?)$/iu.test(choice)) { output.write(helpText()); continue; }
      const entry = /^\d+$/u.test(choice) ? entries[Number(choice) - 1] : entries.find(([kind]) => kind === choice);
      if (!entry) { errorOutput.write('Unknown selection. Choose a listed command.\n'); continue; }
      const [kind, spec] = entry;
      try {
        const command = await collect(kind, spec);
        if (!command || stopped) continue;
        // Herdr machine add inherits stdin for its own approval prompt.
        release();
        const result = command.kind === 'list' ? await manager.list() : await manager.execute(command);
        if (command.kind === 'setup') output.write('API key saved privately.\n');
        else output.write(`${formatResult(result)}\n`);
      } catch (error) {
        let message = String(error?.message ?? error);
        if (currentSecret) message = message.split(currentSecret).join('[redacted]');
        errorOutput.write(`Error: ${terminalText(message)}\n`);
      } finally {
        currentSecret = undefined;
      }
    }
  } finally {
    release();
    process.removeListener('SIGINT', exit);
    output.write('Closed Boat machines.\n');
  }
}
