import type { IRPath } from './stream.ts';
import type { IRTextUpdate } from './text-update-queue.ts';
import type { IR } from './types.ts';
import { parseJSON } from '../shared/json/object.ts';

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
export const createIRStringProjection = () => {
  const previous = new Map<string, string>();
  const emittedText = new Map<string, { path: IRPath; text: string }>();
  const contents = new Map<string, IRProjectedString>();
  const projections: IRStringProjection[] = [];
  const appendSnapshot = (source: IRPath, text: string, target: IRPath, allowReplacement = false): string => {
    const sourceKey = JSON.stringify(source);
    const old = previous.get(sourceKey) ?? '';
    if (!text.startsWith(old)) {
      if (allowReplacement) { assign(source, text, target); previous.set(sourceKey, text); return ''; }
      if (source.at(-1) === 'arguments') {
        const parsed: unknown = parseJSON(old);
        if (JSON.stringify(parsed) === text) return '';
      }
      throw new Error(`Downstream SSE cannot replace emitted text at ${sourceKey}`);
    }
    const delta = text.slice(old.length);
    previous.set(sourceKey, text);
    if (delta === '') return '';
    const key = JSON.stringify(target);
    let content = contents.get(key);
    if (content === undefined) { content = { path: target, text: '' }; contents.set(key, content); }
    const previousProjection = projections.at(-1);
    if (previousProjection !== undefined && JSON.stringify(previousProjection.source_path) === sourceKey && JSON.stringify(previousProjection.target_path) === key && previousProjection.source_end_exclusive === old.length && previousProjection.target_end_exclusive === content.text.length) {
      previousProjection.source_end_exclusive = text.length;
      previousProjection.target_end_exclusive += delta.length;
    } else projections.push({ source_path: source, source_start: old.length, source_end_exclusive: text.length, target_path: target, target_start: content.text.length, target_end_exclusive: content.text.length + delta.length });
    content.text += delta;
    return delta;
  };
  const assign = (source: IRPath, text: string, target: IRPath): void => {
    const key = JSON.stringify(target);
    contents.set(key, { path: target, text });
    for (let i = projections.length - 1; i >= 0; i--) if (JSON.stringify(projections[i].target_path) === key) projections.splice(i, 1);
    projections.push({ source_path: source, source_start: 0, source_end_exclusive: text.length, target_path: target, target_start: 0, target_end_exclusive: text.length });
  };
  const result = (): IRStringProjectionResult => ({ contents: Array.from(contents.values(), content => ({ ...content })), projections: projections.map(projection => ({ ...projection })) });
  const appendText = (update: IRTextUpdate, target: IRPath): string => {
    const key = JSON.stringify(update.path);
    const old = previous.get(key) ?? '';
    if (!update.replacement && old.length !== update.start) throw new Error('IR text projection received an out-of-order fragment');
    const text = update.replacement ? update.text : old + update.text;
    const delta = appendSnapshot(update.path, text, target);
    if (delta !== '') emittedText.set(key, { path: update.path, text });
    return delta;
  };
  const validateText = (state: IR, changed: IRPath): void => {
    for (const [key, { path, text }] of emittedText) {
      if (!path.slice(0, Math.min(path.length, changed.length)).every((segment, index) => segment === changed[index])) continue;
      let value: unknown = state;
      for (const segment of path) value = typeof value === 'object' && value !== null ? (value as Record<string | number, unknown>)[segment] : undefined;
      if (typeof value !== 'string' || !value.startsWith(text)) throw new Error(`Downstream SSE cannot replace emitted text at ${key}`);
    }
  };
  return { appendSnapshot, appendText, validateText, assign, result };
};
