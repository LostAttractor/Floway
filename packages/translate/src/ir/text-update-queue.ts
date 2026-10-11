import type { IRCollector } from './collector.ts';
import type { IRPath, IRRecord } from './stream.ts';
import type { IR } from './types.ts';
import { createJSONPathIndex } from '../shared/json/path-index.ts';

export interface IRTextUpdate { path: IRPath; text: string; start: number; replacement: boolean }

const isTextPath = (state: IR, path: IRPath): boolean => {
  if (path[0] !== 'choices' || path[2] !== 'items') return false;
  const item = state.choices[path[1] as number]?.items[path[3] as number];
  if (item?.type === 'reasoning') return path.length === 6 && (path[4] === 'summary' || path[4] === 'content');
  if (item?.type !== 'message' || path[4] !== 'content') return false;
  const part = item.content[path[5] as number];
  return path.length === 7 && (part?.type === 'text' && path[6] === 'text' || part?.type === 'refusal' && path[6] === 'refusal') || path.length === 8 && part?.type === 'audio' && path[6] === 'audio' && path[7] === 'transcript';
};

const textAt = (collector: IRCollector, path: IRPath): string | undefined => {
  if (!isTextPath(collector.state, path) || !collector.has(path)) return undefined;
  let value: any = collector.state;
  for (const key of path) value = value[key];
  return typeof value === 'string' ? value : undefined;
};

export const createIRTextUpdateQueue = () => {
  const previous = createJSONPathIndex<{ path: IRPath; text: string }>();
  const pending = createJSONPathIndex<{ path: IRPath; entries: { sequence: number; update: IRTextUpdate }[] }>();
  let sequence = 0;
  const push = (update: IRTextUpdate): void => {
    let group = pending.get(update.path);
    if (group === undefined) { group = { path: update.path, entries: [] }; pending.set(update.path, group); }
    group.entries.push({ sequence: sequence++, update });
  };
  const observe = (path: IRPath, text: string): void => {
    const known = previous.get(path);
    if (known?.text === text) return;
    const old = known?.text ?? '';
    const replacement = !text.startsWith(old);
    if (replacement) pending.delete(path);
    push({ path, text: replacement ? text : text.slice(old.length), start: replacement ? 0 : old.length, replacement });
    previous.set(path, { path, text });
  };
  const update = (collector: IRCollector, record: IRRecord): void => {
    if (record.type !== 'operation' || record.operation === 'initialize' || record.path[0] !== 'choices') return;
    const path = record.path;
    if (record.operation === 'append') {
      const text = textAt(collector, path);
      if (text === undefined) return;
      const known = previous.get(path);
      if (known === undefined) observe(path, text);
      else if (record.value !== '') { push({ path, text: record.value, start: known.text.length, replacement: false }); previous.set(path, { path, text }); }
      return;
    }
    for (const known of previous.values(path)) {
      const text = textAt(collector, known.path);
      if (text === undefined) { previous.delete(known.path); pending.delete(known.path); } else observe(known.path, text);
    }
    const { state } = collector;
    const visit = (source: IRPath, text: string): void => {
      if (path.every((key, index) => key === source[index]) && collector.has(source)) observe(source, text);
    };
    const choices = typeof path[1] === 'number' ? [path[1]] : state.choices.map((_, index) => index);
    for (const c of choices) {
      const choice = state.choices[c];
      if (choice === undefined || path[2] !== undefined && path[2] !== 'items') continue;
      const items = typeof path[3] === 'number' ? [path[3]] : choice.items.map((_, index) => index);
      for (const i of items) {
        const item = choice.items[i];
        if (item === undefined) continue;
        const source: IRPath = ['choices', c, 'items', i];
        if (item.type === 'reasoning') {
          for (const field of ['summary', 'content'] as const) {
            if (path[4] !== undefined && path[4] !== field) continue;
            const entries = item[field];
            if (entries === undefined) continue;
            const positions = typeof path[5] === 'number' ? [path[5]] : entries.map((_, index) => index);
            for (const p of positions) if (entries[p] !== undefined) visit([...source, field, p], entries[p]);
          }
        } else if (item.type === 'message' && (path[4] === undefined || path[4] === 'content')) {
          const positions = typeof path[5] === 'number' ? [path[5]] : item.content.map((_, index) => index);
          for (const p of positions) {
            const part = item.content[p];
            const prefix = [...source, 'content', p];
            if (part?.type === 'text') visit([...prefix, 'text'], part.text);
            else if (part?.type === 'refusal') visit([...prefix, 'refusal'], part.refusal);
            else if (part?.type === 'audio' && part.audio.transcript !== undefined) visit([...prefix, 'audio', 'transcript'], part.audio.transcript);
          }
        }
      }
    }
  };
  const drain = (groups: Iterable<{ path: IRPath; entries: { sequence: number; update: IRTextUpdate }[] }>): IRTextUpdate[] => {
    const entries = [];
    for (const group of groups) { entries.push(...group.entries); pending.delete(group.path); }
    return entries.toSorted((a, b) => a.sequence - b.sequence).map(entry => entry.update);
  };
  const takeMatching = (matches: (update: IRTextUpdate) => boolean): IRTextUpdate[] => drain(Array.from(pending.values()).filter(group => matches(group.entries[0].update)));
  const take = (prefix: IRPath): IRTextUpdate[] => drain(Array.from(pending.values(prefix)));
  return { update, take, takeMatching };
};
