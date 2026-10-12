import { createIRCollector, type IRCollector } from './collector.ts';
import type { IRJSONObject, IRValue } from './types.ts';

export type IRPath = readonly (string | number)[];
export type IROperation = Readonly<
  | { type: 'operation'; operation: 'initialize'; path: IRPath; value: IRValue }
  | { type: 'operation'; operation: 'assign'; path: IRPath; value: IRValue }
  | { type: 'operation'; operation: 'append'; path: IRPath; value: string }>;
export type IREvent = Readonly<
  | { type: 'start'; id?: string; created?: number }
  | { type: 'item_end'; choice: number; item: number; status?: 'completed' | 'incomplete' }
  | { type: 'part_end'; choice: number; item: number; part: number }
  | { type: 'choice_end'; choice: number; finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' }
  | { type: 'finish'; status: 'completed' | 'incomplete' }
  | { type: 'error'; error: IRJSONObject }
  | { type: 'ping' }>;
export type IRRecord = IROperation | IREvent;
export interface IRFrame { readonly records: readonly IRRecord[] }

export const createIRBuilder = (maxChoices = 1) => {
  if (!Number.isSafeInteger(maxChoices) || maxChoices <= 0) throw new RangeError(`IR maxChoices must be a positive safe integer: ${maxChoices}`);
  const collector = createIRCollector();
  const { state } = collector;
  let records: IRRecord[] = [];
  const operation = (value: IROperation): void => { if (collector.apply(value)) records.push(value); };
  const assign = (path: IRPath, value: unknown): void => operation({ type: 'operation', operation: 'assign', path, value: value as IRValue });
  const initialize = (path: IRPath, value: unknown): void => operation({ type: 'operation', operation: 'initialize', path, value: value as IRValue });
  const append = (path: IRPath, value: string): void => operation({ type: 'operation', operation: 'append', path, value });
  const event = (value: IREvent): void => { collector.applyEvent(value); records.push(value); };
  const drain = (): IRFrame => { const frame = { records }; records = []; return frame; };
  const choice = (index: number): void => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= maxChoices) throw new RangeError(`IR choice index exceeds the configured choice count: ${index}`);
    while (state.choices.length <= index) initialize(['choices', state.choices.length], { items: [] });
  };
  const item = (choiceIndex: number, value: unknown): number => {
    choice(choiceIndex);
    const position = state.choices[choiceIndex].items.length;
    initialize(['choices', choiceIndex, 'items', position], value);
    return position;
  };
  return { collector, state, initialize, assign, append, event, drain, choice, item };
};

export const consumeIRRecords = async function* (frames: AsyncIterable<IRFrame>): AsyncGenerator<{ record: IRRecord; collector: IRCollector }> {
  const collector = createIRCollector();
  let started = false;
  let finished = false;
  for await (const frame of frames) for (const record of frame.records) {
    if (finished) throw new Error('IR record arrived after finish');
    if (record.type === 'operation') collector.apply(record);
    else {
      if (record.type === 'start') {
        if (started) throw new Error('Duplicate IR start');
        started = true;
      } else if (record.type === 'finish') {
        if (!started) throw new Error('IR finish arrived before start');
        finished = true;
      } else if (record.type === 'error') finished = true;
      collector.applyEvent(record);
    }
    yield { record, collector };
  }
  if (!finished) throw new Error('IR stream ended without finish');
};
