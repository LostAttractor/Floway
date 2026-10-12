import type { IRPath } from './stream.ts';

const keyOf = (path: IRPath): string => JSON.stringify(path);

export const createIROrdinalMapper = () => {
  const ordinals = new Map<string, number>();
  let next = 0;
  const open = (path: IRPath): number => {
    const key = keyOf(path);
    if (ordinals.has(key)) throw new TypeError(`IR unit is already open: ${key}`);
    const ordinal = next++;
    ordinals.set(key, ordinal);
    return ordinal;
  };
  const get = (path: IRPath): number => {
    const key = keyOf(path);
    const ordinal = ordinals.get(key);
    if (ordinal === undefined) throw new TypeError(`Unknown open IR unit: ${key}`);
    return ordinal;
  };
  const close = (path: IRPath): void => {
    get(path);
    ordinals.delete(keyOf(path));
  };
  return { open, get, close };
};
