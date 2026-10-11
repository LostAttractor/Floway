import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const arguments_ = process.argv.slice(2);
const fix = arguments_[0] === '--fix';
if (fix) arguments_.shift();
if (arguments_[0] === '--') arguments_.shift();
const paths = arguments_;

const fail = (message: string): never => {
  throw new Error(`lint paths: ${message}`);
};

if (paths.length === 0) {
  fail('pass one or more task-relevant files or directories after `--`');
}

const normalizedPaths = paths.map(path => {
  if (path.startsWith('-')) fail(`options are not accepted as paths: ${JSON.stringify(path)}`);
  if (isAbsolute(path)) fail(`paths must be relative to the repository: ${JSON.stringify(path)}`);

  const absolutePath = realpathSync(resolve(ROOT, path));
  const repositoryPath = relative(ROOT, absolutePath);
  if (repositoryPath === '' || repositoryPath.startsWith(`..${sep}`) || repositoryPath === '..') {
    fail(`path must identify a file or directory inside the repository: ${JSON.stringify(path)}`);
  }
  return repositoryPath;
});

const result = spawnSync(
  process.platform === 'win32' ? 'eslint.cmd' : 'eslint',
  ['--cache', ...(fix ? ['--fix'] : []), ...normalizedPaths],
  { cwd: ROOT, env: process.env, stdio: 'inherit' },
);

if (result.error) throw result.error;
if (result.signal) fail(`ESLint terminated from signal ${result.signal}`);
process.exitCode = result.status ?? 1;
