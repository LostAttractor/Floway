import type { IR, IRJSONValue, IRJSONObject } from './types.ts';
import { createIRValues, type IRValues } from './values.ts';
import { cloneJSON } from '../shared/json/clone.ts';

export type IRPath = readonly (string | number)[];
// initialize creates unpublished structure; assign publishes its complete value, and append publishes only string fragments.
// Frame grouping has no semantic effect. Array initialization must address the next index.
export type IROperation =
  | { type: 'operation'; operation: 'initialize'; path: IRPath; value: IRJSONValue }
  | { type: 'operation'; operation: 'assign'; path: IRPath; value: IRJSONValue }
  | { type: 'operation'; operation: 'append'; path: IRPath; value: string };
export type IREvent =
  | { type: 'start'; id: string; model: string; created?: number }
  | { type: 'item_start'; choice: number; item: number }
  | { type: 'item_end'; choice: number; item: number; status?: 'completed' | 'incomplete' }
  | { type: 'part_start' | 'part_end'; choice: number; item: number; part: number }
  | { type: 'choice_end'; choice: number; finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' }
  | { type: 'finish'; status: 'completed' | 'incomplete' | 'failed'; error?: IRJSONObject }
  | { type: 'error'; error: IRJSONObject }
  | { type: 'ping' };
export type IRRecord = IROperation | IREvent;
export interface IRFrame { records: IRRecord[] }

const getIRValue = (root: unknown, path: IRPath): unknown => {
  let value = root;
  for (const key of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) throw new TypeError(`Missing IR path: ${JSON.stringify(path)}`);
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
};

export const applyIROperation = (state: IR, operation: IROperation): void => {
  const key = operation.path.at(-1);
  if (key === undefined) throw new TypeError('IR operations require a property path');
  const parent = getIRValue(state, operation.path.slice(0, -1));
  if (typeof parent !== 'object' || parent === null) throw new TypeError('IR operation parent must be an object or array');
  if (Array.isArray(parent) && (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > parent.length)) throw new TypeError('IR array operation requires a contiguous nonnegative index');
  const target = parent as Record<string | number, unknown>;
  const value = cloneJSON(operation.value);
  if (operation.operation === 'initialize' && Object.hasOwn(target, key)) throw new TypeError('IR initialize requires an absent target');
  if (operation.operation === 'assign' || operation.operation === 'initialize') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  } else if (typeof target[key] === 'string' && typeof value === 'string') {
    target[key] += value;
  } else throw new TypeError('IR append requires a string target');
};

export const createIRBuilder = () => {
  const state: IR = { choices: [], extensions: {} };
  let records: IRRecord[] = [];
  const operation = (op: IROperation): void => {
    applyIROperation(state, op);
    records.push(op);
  };
  const assign = (path: IRPath, value: unknown): void => operation({ type: 'operation', operation: 'assign', path, value: cloneJSON(value) as IRJSONValue });
  const initialize = (path: IRPath, value: unknown): void => operation({ type: 'operation', operation: 'initialize', path, value: cloneJSON(value) as IRJSONValue });
  const append = (path: IRPath, value: string): void => operation({ type: 'operation', operation: 'append', path, value });
  const event = (value: IREvent): void => { records.push(value); };
  const drain = (): IRFrame => {
    const frame = { records };
    records = [];
    return frame;
  };
  const choice = (index: number): void => {
    while (state.choices.length <= index) initialize(['choices', state.choices.length], { items: [] });
  };
  const item = (index: number, value: unknown): number => {
    choice(index);
    const position = state.choices[index].items.length;
    assign(['choices', index, 'items', position], value);
    event({ type: 'item_start', choice: index, item: position });
    return position;
  };
  return { state, initialize, assign, append, event, drain, choice, item };
};

type IRBuilder = ReturnType<typeof createIRBuilder>;

export const reconcileIRValue = (builder: IRBuilder, path: IRPath, previous: unknown, next: unknown): void => {
  if (Object.is(previous, next)) return;
  if (typeof previous === 'string' && typeof next === 'string' && next.startsWith(previous)) {
    builder.append(path, next.slice(previous.length));
  } else if (Array.isArray(previous) && Array.isArray(next) && next.length >= previous.length) {
    previous.forEach((value, index) => reconcileIRValue(builder, [...path, index], value, next[index]));
    for (let index = previous.length; index < next.length; index++) builder.assign([...path, index], next[index]);
  } else if (previous !== null && next !== null && typeof previous === 'object' && typeof next === 'object' && !Array.isArray(previous) && !Array.isArray(next) && Object.keys(previous).every(key => Object.hasOwn(next, key))) {
    for (const [key, value] of Object.entries(next)) reconcileIRValue(builder, [...path, key], (previous as Record<string, unknown>)[key], value);
  } else builder.assign(path, next);
};

export const consumeIRRecords = async function* (frames: AsyncIterable<IRFrame>): AsyncGenerator<{ state: IR; record: IRRecord; values: IRValues }> {
  const state: IR = { choices: [], extensions: {} };
  const values = createIRValues();
  let started = false;
  let finished = false;
  for await (const frame of frames) for (const record of frame.records) {
    if (finished) throw new Error('IR record arrived after finish');
    if (record.type === 'operation') { applyIROperation(state, record); values.apply(record); } else if (record.type === 'start') {
      if (started) throw new Error('Duplicate IR start');
      started = true;
    } else if (record.type === 'finish') {
      if (!started) throw new Error('IR finish arrived before start');
      finished = true;
    } else if (record.type === 'error') finished = true;
    yield { state, record, values };
  }
  if (!finished) throw new Error('IR stream ended without finish');
};
