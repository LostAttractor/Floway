// wrangler.jsonc is contributor-owned and gitignored. The checked-in example
// defines the Worker topology, while concrete placeholder replacements and an
// optional account_id remain local.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, type ParseError } from 'jsonc-parser';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE_PATH = resolve(ROOT, 'wrangler.example.jsonc');
const REAL_PATH = resolve(ROOT, 'wrangler.jsonc');

const PLACEHOLDER_RE = /^<YOUR_[A-Z0-9_]+>$/;
const isPlaceholder = (v: unknown): v is string => typeof v === 'string' && PLACEHOLDER_RE.test(v);

// Top-level keys the real config may carry without a matching example
// entry. Kept as narrow as possible — every addition weakens the gate.
const REAL_ONLY_OPTIONAL_KEYS = new Set(['account_id']);

interface Mismatch {
  path: string;
  reason: string;
}

const fmt = (v: unknown): string => JSON.stringify(v);
const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const isBindingArray = (arr: readonly unknown[]): arr is ReadonlyArray<Record<string, unknown>> =>
  arr.length > 0 && arr.every(
    e => typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).binding === 'string',
  );

const hasBinding = (value: unknown): value is Record<string, unknown> & { binding: string } =>
  typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).binding === 'string';

const compare = (expected: unknown, actual: unknown, path: string, out: Mismatch[]): void => {
  if (isPlaceholder(expected)) {
    if (typeof actual !== 'string' || actual.trim().length === 0 || isPlaceholder(actual)) {
      out.push({ path, reason: `placeholder ${expected} must be replaced with a concrete value, got ${fmt(actual)}` });
    }
    return;
  }

  if (isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push({ path, reason: `expected array, got ${fmt(actual)}` });
      return;
    }
    // Bindings (d1_databases, r2_buckets, kv_namespaces, ...) are identified
    // by their `binding` name, not array position. Match each example entry
    // to the real entry with the same binding, and reject any real entry
    // whose binding name the example doesn't pin.
    if (isBindingArray(expected)) {
      const actualBindings = actual.filter(hasBinding);
      for (const [index, entry] of actual.entries()) {
        if (!hasBinding(entry)) out.push({ path: `${path}[${index}]`, reason: 'binding entry must be an object with a string binding' });
      }
      const duplicates = actualBindings
        .map(entry => entry.binding)
        .filter((name, index, names) => names.indexOf(name) !== index);
      for (const name of new Set(duplicates)) {
        out.push({ path: `${path}[binding=${name}]`, reason: 'binding appears more than once' });
      }
      const expectedNameList = expected.map(entry => entry.binding as string);
      const expectedDuplicates = expectedNameList.filter((name, index) => expectedNameList.indexOf(name) !== index);
      for (const name of new Set(expectedDuplicates)) {
        out.push({ path: `${path}[binding=${name}]`, reason: 'binding appears more than once in wrangler.example.jsonc' });
      }
      const expectedNames = new Set(expectedNameList);
      for (const exp of expected) {
        const name = exp.binding as string;
        const match = actualBindings.find(entry => entry.binding === name);
        if (match === undefined) {
          out.push({ path: `${path}[binding=${name}]`, reason: 'binding entry missing' });
          continue;
        }
        compare(exp, match, `${path}[binding=${name}]`, out);
      }
      for (const { binding: name } of actualBindings) {
        if (!expectedNames.has(name)) {
          out.push({ path: `${path}[binding=${name}]`, reason: 'binding present in wrangler.jsonc but not in the example' });
        }
      }
      return;
    }
    // Cloudflare states that run_worker_first pattern order is not significant:
    // https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
    if (path === 'assets.run_worker_first') {
      const expectedStrings = expected.filter((value): value is string => typeof value === 'string');
      const expectedDuplicates = expectedStrings.filter((value, index) => expectedStrings.indexOf(value) !== index);
      for (const value of new Set(expectedDuplicates)) {
        out.push({ path, reason: `entry ${fmt(value)} appears more than once in wrangler.example.jsonc` });
      }
      const actualStrings = actual.filter((value): value is string => typeof value === 'string');
      for (const [index, value] of actual.entries()) {
        if (typeof value !== 'string') out.push({ path: `${path}[${index}]`, reason: `expected a string entry, got ${fmt(value)}` });
      }
      const duplicates = actualStrings.filter((value, index) => actualStrings.indexOf(value) !== index);
      for (const value of new Set(duplicates)) out.push({ path, reason: `entry ${fmt(value)} appears more than once` });
      const actualSet = new Set(actualStrings);
      for (const value of expectedStrings) {
        if (!actualSet.has(value)) out.push({ path, reason: `entry ${fmt(value)} missing` });
      }
      const expectedSet = new Set(expectedStrings);
      for (const value of actualStrings) {
        if (!expectedSet.has(value)) {
          out.push({ path, reason: `entry ${fmt(value)} present in wrangler.jsonc but not in the example` });
        }
      }
      return;
    }
    if (expected.length !== actual.length) {
      out.push({ path, reason: `expected array of length ${expected.length}, got ${actual.length}` });
      return;
    }
    expected.forEach((v, i) => compare(v, actual[i], `${path}[${i}]`, out));
    return;
  }

  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      out.push({ path, reason: `expected object, got ${fmt(actual)}` });
      return;
    }
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expectedRecord)) {
      compare(value, actualRecord[key], path === '' ? key : `${path}.${key}`, out);
    }
    for (const key of Object.keys(actualRecord)) {
      if (key in expectedRecord) continue;
      if (path === '' && REAL_ONLY_OPTIONAL_KEYS.has(key)) continue;
      out.push({
        path: path === '' ? key : `${path}.${key}`,
        reason: 'key present in wrangler.jsonc but not in the example',
      });
    }
    return;
  }

  if (expected !== actual) {
    out.push({ path, reason: `expected ${fmt(expected)}, got ${fmt(actual)}` });
  }
};

const parseJsonc = async (path: string): Promise<unknown> => {
  const text = await readFile(path, 'utf8');
  const errors: ParseError[] = [];
  const value = parse(text, errors);
  if (errors.length > 0) {
    throw new Error(`Failed to parse ${path}: ${errors.map(error => JSON.stringify(error)).join(', ')}`);
  }
  return value;
};

const [example, real] = await Promise.all([parseJsonc(EXAMPLE_PATH), parseJsonc(REAL_PATH)]);
const mismatches: Mismatch[] = [];
compare(example, real, '', mismatches);

if (mismatches.length > 0) {
  console.error('wrangler.jsonc drifted from wrangler.example.jsonc:');
  for (const m of mismatches) console.error(`  - ${m.path}: ${m.reason}`);
  console.error('Mirror wrangler.example.jsonc, filling in every <YOUR_*> placeholder with your own value.');
  process.exit(1);
}
