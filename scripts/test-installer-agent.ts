import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = process.argv.slice(2);
if (arguments_[0] === '--') arguments_.shift();
const agents = new Set(['claude', 'codex', 'pi', 'omp']);

if (arguments_.length !== 2 || arguments_[0] !== '--agent' || !agents.has(arguments_[1]!)) {
  throw new Error('installer tests: select exactly one agent with `--agent claude|codex|pi|omp`');
}

const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['--filter', '@floway-dev/agent-setup', 'run', 'test:installers', '--', ...arguments_],
  { cwd: ROOT, env: process.env, stdio: 'inherit' },
);

if (result.error) throw result.error;
if (result.signal) throw new Error(`installer tests: harness terminated from signal ${result.signal}`);
process.exitCode = result.status ?? 1;
