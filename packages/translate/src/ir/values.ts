import type { IRJSONValue } from './model.ts';
import type { IROperation, IRPath } from './stream.ts';

const contains = (parent: IRPath, child: IRPath): boolean => parent.length <= child.length && parent.every((key, index) => key === child[index]);

export const createIRValues = () => {
  const paths = new Map<string, IRPath>();
  const publish = (path: IRPath, value: IRJSONValue): void => {
    paths.set(JSON.stringify(path), path);
    if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) publish([...path, Array.isArray(value) ? Number(key) : key], child);
  };
  const apply = (operation: IROperation): void => {
    if (operation.operation === 'initialize') return;
    if (operation.operation === 'assign') for (const [key, path] of paths) if (contains(operation.path, path)) paths.delete(key);
    publish(operation.path, operation.value);
  };
  const has = (path: IRPath): boolean => paths.has(JSON.stringify(path));
  const within = (path: IRPath): boolean => [...paths.values()].some(value => contains(path, value));
  const read = (path: IRPath, value: unknown): any => {
    if (!within(path)) return undefined;
    if (value === null || typeof value !== 'object') return has(path) ? value : undefined;
    if (Array.isArray(value)) return value.map((child, index) => read([...path, index], child));
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      const actual = read([...path, key], child);
      return actual === undefined ? [] : [[key, actual]];
    }));
  };
  return { apply, has, within, read };
};
export type IRValues = ReturnType<typeof createIRValues>;
