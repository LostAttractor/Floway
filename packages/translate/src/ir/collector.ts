import type { IROperation, IRPath } from './stream.ts';
import type { IR } from './types.ts';
import { createJSONPathIndex } from '../shared/json/path-index.ts';

const getIRValue = (root: unknown, path: IRPath): unknown => {
  let value = root;
  for (const key of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) throw new TypeError(`Missing IR path: ${JSON.stringify(path)}`);
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
};

const applyIROperation = (state: IR, owned: WeakSet<object>, operation: IROperation): boolean => {
  const key = operation.path.at(-1);
  if (key === undefined) throw new TypeError('IR operations require a property path');
  const parentPath = operation.path.slice(0, -1);
  const parent = getIRValue(state, parentPath);
  if (typeof parent !== 'object' || parent === null) throw new TypeError('IR operation parent must be an object or array');
  if (Array.isArray(parent) && (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > parent.length)) throw new TypeError('IR array operation requires a contiguous nonnegative index');
  let target = parent as Record<string | number, unknown>;
  const value = operation.value;
  if (operation.operation === 'initialize' && Object.hasOwn(target, key)) throw new TypeError('IR initialize requires an absent target');
  if (operation.operation === 'append' && (typeof target[key] !== 'string' || typeof value !== 'string')) throw new TypeError('IR append requires a string target');
  if (operation.operation === 'assign' && Object.hasOwn(target, key) && Object.is(target[key], value) || operation.operation === 'append' && value === '') return false;
  // Record payloads are immutable borrowed trees. Only containers on a write path become collector-owned.
  target = state as unknown as Record<string | number, unknown>;
  for (const segment of parentPath) {
    const child = target[segment] as object;
    if (!owned.has(child)) {
      const copy = Array.isArray(child) ? [...child] : { ...child };
      owned.add(copy);
      Object.defineProperty(target, segment, { value: copy, writable: true, enumerable: true, configurable: true });
    }
    target = target[segment] as Record<string | number, unknown>;
  }
  if (operation.operation === 'assign' || operation.operation === 'initialize') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  } else target[key] = (target[key] as string) + operation.value;
  return true;
};

// State is a live readonly view; retain paths, not containers, across operations.
export const createIRState = () => {
  const state: IR = { choices: [], extensions: {} };
  const owned = new WeakSet<object>([state, state.choices, state.extensions!]);
  return { state, apply: (operation: IROperation): boolean => applyIROperation(state, owned, operation) };
};

export const createIRCollector = () => {
  const accumulator = createIRState();
  const { state } = accumulator;
  const paths = createJSONPathIndex<IRPath>();
  const publish = (path: IRPath, value: IROperation['value']): void => {
    paths.set(path, path);
    if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) publish([...path, Array.isArray(value) ? Number(key) : key], child);
  };
  const apply = (operation: IROperation): void => {
    const changed = accumulator.apply(operation);
    if (operation.operation === 'initialize') { paths.touch(operation.path); return; }
    if (!changed && paths.get(operation.path) !== undefined) return;
    if (operation.operation === 'assign') paths.delete(operation.path);
    publish(operation.path, operation.value);
  };
  const has = (path: IRPath): boolean => paths.get(path) !== undefined;
  const within = paths.within;
  const project = (path: IRPath, value: unknown): any => {
    if (!within(path)) return undefined;
    if (value === null || typeof value !== 'object') return has(path) ? value : undefined;
    if (Array.isArray(value)) return value.map((child, index) => project([...path, index], child));
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      const actual = project([...path, key], child);
      return actual === undefined ? [] : [[key, actual]];
    }));
  };
  const read = (path: IRPath): any => within(path) ? project(path, getIRValue(state, path)) : undefined;
  return { state, apply, has, within, read, version: paths.version };
};
export type IRCollector = ReturnType<typeof createIRCollector>;
