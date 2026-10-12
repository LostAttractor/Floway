import type { IRPath } from './stream.ts';

const isIndex = (value: string | number | undefined): value is number => typeof value === 'number';

export const isIRAppendTarget = (path: IRPath, value?: unknown): boolean => {
  if (path[0] !== 'choices' || !isIndex(path[1]) || path[2] !== 'items' || !isIndex(path[3])) return false;
  if (path.length === 5) return path[4] === 'arguments' || path[4] === 'input';
  if (path.length === 6 && isIndex(path[5])) return path[4] === 'summary' || path[4] === 'content' && typeof value === 'string';
  if (path.length === 7 && path[4] === 'content' && isIndex(path[5])) return path[6] === 'text' || path[6] === 'refusal';
  return path.length === 8 && path[4] === 'content' && isIndex(path[5]) && path[6] === 'audio' && (path[7] === 'data' || path[7] === 'transcript');
};

export const isIRNoneTarget = (path: IRPath): boolean => path.length === 5
  && path[0] === 'choices'
  && isIndex(path[1])
  && path[2] === 'items'
  && isIndex(path[3])
  && path[4] === 'call_id';
