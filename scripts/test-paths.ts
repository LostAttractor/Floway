import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const paths = process.argv.slice(2);
if (paths[0] === '--') paths.shift();

const fail = (message: string): never => {
  throw new Error(`test paths: ${message}`);
};

if (paths.length === 0) {
  fail('pass one or more task-relevant paths under `__tests__` after `--`');
}

const normalizedPaths = paths.map(path => {
  if (path.startsWith('-')) fail(`options are not accepted as paths: ${JSON.stringify(path)}`);
  if (isAbsolute(path)) fail(`paths must be relative to the repository: ${JSON.stringify(path)}`);

  const absolutePath = realpathSync(resolve(ROOT, path));
  const repositoryPath = relative(ROOT, absolutePath);
  if (repositoryPath === '' || repositoryPath.startsWith(`..${sep}`) || repositoryPath === '..') {
    fail(`path must identify a file or directory inside the repository: ${JSON.stringify(path)}`);
  }
  if (!repositoryPath.split(sep).includes('__tests__')) {
    fail(`path must be inside an __tests__ directory: ${JSON.stringify(path)}`);
  }
  return repositoryPath;
});

const result = spawnSync(
  process.platform === 'win32' ? 'vitest.cmd' : 'vitest',
  ['run', ...normalizedPaths],
  { cwd: ROOT, env: process.env, stdio: 'inherit' },
);

if (result.error) throw result.error;
if (result.signal) fail(`Vitest terminated from signal ${result.signal}`);
process.exitCode = result.status ?? 1;
