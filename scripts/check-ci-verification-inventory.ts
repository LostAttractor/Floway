import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = resolve(ROOT, 'package.json');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/verify.yaml');
const RUN_VALUE = /^\s*run:\s*(\S.*?)\s*$/gm;
const SCRIPT_CALL = /^pnpm run ([\w:-]+)$/;
const CI_GUARD = 'jiti scripts/require-github-actions.ts && ';
const SHARED_CI_SCRIPTS = new Set(['build:web']);
const SETUP_COMMANDS = new Set([
  'corepack enable',
  'pnpm install --frozen-lockfile',
  'npm install --prefix data/codex-ci --no-save --package-lock=false @openai/codex@latest',
  '${{ matrix.check.run }}',
]);
const SETUP_SCRIPTS = new Set(['typegen']);

const fail = (message: string): never => {
  throw new Error(`CI verification inventory: ${message}`);
};

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as {
  scripts: Record<string, string | undefined>;
};
const scripts = manifest.scripts;

if (scripts.verify !== undefined) fail('package.json must not define an aggregate `verify` script');

const expectedScripts = Object.keys(scripts)
  .filter(name => name.startsWith('ci:') || name.startsWith('check:') || SHARED_CI_SCRIPTS.has(name))
  .sort();

for (const name of expectedScripts.filter(name => name.startsWith('ci:'))) {
  if (!scripts[name]?.startsWith(CI_GUARD)) {
    fail(`\`${name}\` must start with ${JSON.stringify(CI_GUARD)}`);
  }
}

const workflow = await readFile(WORKFLOW_PATH, 'utf8');
const workflowScripts = [...workflow.matchAll(RUN_VALUE)]
  .map(([, command]) => command!)
  .filter(command => !SETUP_COMMANDS.has(command))
  .map(command => SCRIPT_CALL.exec(command)?.[1] ?? fail(`verify.yaml runs unsupported command ${JSON.stringify(command)}`))
  .filter(name => !SETUP_SCRIPTS.has(name));

for (const name of workflowScripts) {
  if (scripts[name] === undefined) fail(`verify.yaml calls undefined package script ${JSON.stringify(name)}`);
}

const actualScripts = [...workflowScripts].sort();
if (JSON.stringify(actualScripts) !== JSON.stringify(expectedScripts)) {
  fail(`verify.yaml must run exactly ${JSON.stringify(expectedScripts)} once each; received ${JSON.stringify(actualScripts)}`);
}
