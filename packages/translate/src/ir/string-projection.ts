import type { IRPath, IRRecord } from './stream.ts';
import type { IRTextUpdate } from './text-update-queue.ts';
import type { IR } from './types.ts';
import { parseJSON } from '../shared/json/object.ts';
import { createJSONPathIndex } from '../shared/json/path-index.ts';

interface IRStringProjection {
  source_path: IRPath;
  source_start: number;
  source_end_exclusive: number;
  target_path: IRPath;
  target_start: number;
  target_end_exclusive: number;
}
interface IRProjectedString { path: IRPath; text: string }
interface IRStringProjectionResult { readonly contents: readonly Readonly<IRProjectedString>[]; readonly projections: readonly Readonly<IRStringProjection>[] }
interface IRProjectedSource { path: IRPath; length: number; fragments: string[]; snapshot?: string }
interface IRProjectionEntry { value: IRStringProjection; source: string; target: string }

export const createIRStringProjection = () => {
  const previous = createJSONPathIndex<IRProjectedSource>();
  const emittedText = createJSONPathIndex<IRProjectedSource>();
  const contents = new Map<string, IRProjectedString>();
  const projections = new Set<IRProjectionEntry>();
  const targets = new Map<string, Set<IRProjectionEntry>>();
  const sources = new Map<string, Set<IRProjectionEntry>>();
  let lastProjection: IRProjectionEntry | undefined;
  const snapshot = (source: IRProjectedSource): string => source.snapshot ??= source.fragments.join('');
  const addProjection = (entry: IRProjectionEntry): void => {
    projections.add(entry);
    let target = targets.get(entry.target);
    if (target === undefined) { target = new Set(); targets.set(entry.target, target); }
    target.add(entry);
    let source = sources.get(entry.source);
    if (source === undefined) { source = new Set(); sources.set(entry.source, source); }
    source.add(entry); lastProjection = entry;
  };
  const append = (source: IRPath, delta: string, target: IRPath): string => {
    let old = previous.get(source);
    if (old === undefined) { old = { path: source, length: 0, fragments: [] }; previous.set(source, old); }
    const start = old.length;
    old.length += delta.length;
    if (delta === '') return '';
    old.fragments.push(delta); old.snapshot = undefined;
    const sourceKey = JSON.stringify(source);
    const key = JSON.stringify(target);
    let content = contents.get(key);
    if (content === undefined) { content = { path: target, text: '' }; contents.set(key, content); }
    const last = lastProjection;
    if (last?.source === sourceKey && last.target === key && last.value.source_end_exclusive === start && last.value.target_end_exclusive === content.text.length) {
      last.value.source_end_exclusive = old.length;
      last.value.target_end_exclusive += delta.length;
    } else addProjection({ source: sourceKey, target: key, value: { source_path: source, source_start: start, source_end_exclusive: old.length, target_path: target, target_start: content.text.length, target_end_exclusive: content.text.length + delta.length } });
    content.text += delta;
    return delta;
  };
  const assign = (source: IRPath, text: string, target: IRPath): void => {
    const key = JSON.stringify(target);
    const entries = targets.get(key);
    const sourceKey = JSON.stringify(source);
    if (contents.get(key)?.text === text && entries?.size === 1) {
      const entry = entries.values().next().value!;
      if (entry.source === sourceKey && entry.value.source_start === 0 && entry.value.target_start === 0 && entry.value.source_end_exclusive === text.length && entry.value.target_end_exclusive === text.length) return;
    }
    contents.set(key, { path: target, text });
    if (entries !== undefined) for (const entry of entries) { projections.delete(entry); sources.get(entry.source)!.delete(entry); }
    targets.delete(key);
    addProjection({ source: sourceKey, target: key, value: { source_path: source, source_start: 0, source_end_exclusive: text.length, target_path: target, target_start: 0, target_end_exclusive: text.length } });
  };
  const appendSnapshot = (source: IRPath, text: string, target: IRPath, allowReplacement = false): string => {
    const known = previous.get(source);
    const old = known === undefined ? '' : snapshot(known);
    if (text === old) return '';
    if (!text.startsWith(old)) {
      if (allowReplacement) { assign(source, text, target); previous.set(source, { path: source, length: text.length, fragments: [text], snapshot: text }); return ''; }
      if (source.at(-1) === 'arguments') {
        const parsed: unknown = parseJSON(old);
        if (JSON.stringify(parsed) === text) return '';
      }
      throw new Error(`Downstream SSE cannot replace emitted text at ${JSON.stringify(source)}`);
    }
    const delta = append(source, text.slice(old.length), target);
    const value = previous.get(source)!;
    value.fragments = [text]; value.snapshot = text;
    return delta;
  };
  const appendFromRecord = (record: IRRecord, source: IRPath, text: string, target: IRPath, allowReplacement = false): string => {
    const oldLength = previous.get(source)?.length ?? 0;
    if (record.type === 'operation' && record.operation === 'append' && record.path.length === source.length && source.every((key, index) => key === record.path[index]) && oldLength + record.value.length === text.length) return append(source, record.value, target);
    return appendSnapshot(source, text, target, allowReplacement);
  };
  const result = (): IRStringProjectionResult => ({ contents: Array.from(contents.values(), content => ({ ...content })), projections: Array.from(projections, entry => ({ ...entry.value })) });
  const appendText = (update: IRTextUpdate, target: IRPath): string => {
    const oldLength = previous.get(update.path)?.length ?? 0;
    if (!update.replacement && oldLength !== update.start) throw new Error('IR text projection received an out-of-order fragment');
    const delta = update.replacement ? appendSnapshot(update.path, update.text, target) : append(update.path, update.text, target);
    if (delta !== '') emittedText.set(update.path, previous.get(update.path)!);
    return delta;
  };
  const validateText = (state: IR, changed: IRPath): void => {
    const validate = (source: IRProjectedSource): void => {
      let value: unknown = state;
      for (const segment of source.path) value = typeof value === 'object' && value !== null ? (value as Record<string | number, unknown>)[segment] : undefined;
      if (typeof value !== 'string' || !value.startsWith(snapshot(source))) throw new Error(`Downstream SSE cannot replace emitted text at ${JSON.stringify(source.path)}`);
    };
    for (const source of emittedText.values(changed)) validate(source);
    for (let length = 0; length < changed.length; length++) {
      const source = emittedText.get(changed.slice(0, length));
      if (source !== undefined) validate(source);
    }
  };
  const forSource = (path: IRPath): readonly Readonly<IRStringProjection>[] => Array.from(sources.get(JSON.stringify(path)) ?? [], entry => ({ ...entry.value }));
  const text = (path: IRPath): string | undefined => contents.get(JSON.stringify(path))?.text;
  return { appendSnapshot, appendFromRecord, appendText, validateText, assign, result, forSource, text };
};
