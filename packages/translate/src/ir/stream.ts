import { createIRCollector, type IRCollector } from './collector.ts';
import type { IRJSONValue, IRJSONObject } from './types.ts';
import { cloneJSON } from '../shared/json/clone.ts';

export type IRPath = readonly (string | number)[];
// initialize creates unpublished structure; assign publishes its complete value, and append publishes only string fragments.
// Frame grouping has no semantic effect. Array initialization must address the next index.
export type IROperation = Readonly<
  | { type: 'operation'; operation: 'initialize'; path: IRPath; value: IRJSONValue }
  | { type: 'operation'; operation: 'assign'; path: IRPath; value: IRJSONValue }
  | { type: 'operation'; operation: 'append'; path: IRPath; value: string }>;
export type IREvent = Readonly<
  | { type: 'start'; id: string; model: string; created?: number }
  | { type: 'item_start'; choice: number; item: number }
  | { type: 'item_end'; choice: number; item: number; status?: 'completed' | 'incomplete' }
  | { type: 'part_start' | 'part_end'; choice: number; item: number; part: number }
  | { type: 'choice_end'; choice: number; finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' }
  | { type: 'finish'; status: 'completed' | 'incomplete' | 'failed'; error?: IRJSONObject }
  | { type: 'error'; error: IRJSONObject }
  | { type: 'ping' }>;
export type IRRecord = IROperation | IREvent;
export interface IRFrame { readonly records: readonly IRRecord[] }

// Values and paths passed to the builder are transferred to immutable records.
// Callers retaining mutable objects must snapshot them before transfer; collectors borrow records.
export const createIRBuilder = () => {
  const collector = createIRCollector();
  const { state } = collector;
  let records: IRRecord[] = [];
  const operation = (op: IROperation): void => {
    collector.apply(op);
    records.push(op);
  };
  const assign = (path: IRPath, value: unknown): void => operation({ type: 'operation', operation: 'assign', path, value: value as IRJSONValue });
  const initialize = (path: IRPath, value: unknown): void => operation({ type: 'operation', operation: 'initialize', path, value: value as IRJSONValue });
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

// Reconciliation borrows the next snapshot, transferring only snapshots of changed assigned subtrees.
export const reconcileIRValue = (builder: IRBuilder, path: IRPath, previous: unknown, next: unknown): void => {
  if (Object.is(previous, next)) return;
  if (typeof previous === 'string' && typeof next === 'string' && next.startsWith(previous)) {
    builder.append(path, next.slice(previous.length));
  } else if (Array.isArray(previous) && Array.isArray(next) && next.length >= previous.length) {
    previous.forEach((value, index) => reconcileIRValue(builder, [...path, index], value, next[index]));
    for (let index = previous.length; index < next.length; index++) builder.assign([...path, index], cloneJSON(next[index]));
  } else if (previous !== null && next !== null && typeof previous === 'object' && typeof next === 'object' && !Array.isArray(previous) && !Array.isArray(next) && Object.keys(previous).every(key => Object.hasOwn(next, key))) {
    for (const [key, value] of Object.entries(next)) reconcileIRValue(builder, [...path, key], (previous as Record<string, unknown>)[key], value);
  } else builder.assign(path, cloneJSON(next));
};

export const consumeIRRecords = async function* (frames: AsyncIterable<IRFrame>): AsyncGenerator<{ record: IRRecord; collector: IRCollector }> {
  const collector = createIRCollector();
  let started = false;
  let finished = false;
  for await (const frame of frames) for (const record of frame.records) {
    if (finished) throw new Error('IR record arrived after finish');
    if (record.type === 'operation') { collector.apply(record); } else if (record.type === 'start') {
      if (started) throw new Error('Duplicate IR start');
      started = true;
    } else if (record.type === 'finish') {
      if (!started) throw new Error('IR finish arrived before start');
      finished = true;
    } else if (record.type === 'error') finished = true;
    yield { record, collector };
  }
  if (!finished) throw new Error('IR stream ended without finish');
};
