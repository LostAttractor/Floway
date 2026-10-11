export type JSONPath = readonly (string | number)[];

interface JSONPathNode<T> { value?: T; present: boolean; size: number; version: number; children: Map<string | number, JSONPathNode<T>> }

export const createJSONPathIndex = <T>() => {
  const node = (): JSONPathNode<T> => ({ present: false, size: 0, version: 0, children: new Map() });
  const root = node();
  let version = 0;
  const branch = (path: JSONPath, create = false): JSONPathNode<T>[] => {
    const result = [root];
    for (const key of path) {
      const parent = result.at(-1)!;
      let child = parent.children.get(key);
      if (child === undefined) {
        if (!create) return [];
        child = node(); parent.children.set(key, child);
      }
      result.push(child);
    }
    return result;
  };
  const find = (path: JSONPath): JSONPathNode<T> | undefined => {
    let target = root;
    for (const key of path) {
      const child = target.children.get(key);
      if (child === undefined) return undefined;
      target = child;
    }
    return target;
  };
  const get = (path: JSONPath): T | undefined => find(path)?.value;
  const touch = (path: JSONPath): void => { const nodes = branch(path, true); version++; for (const item of nodes) item.version = version; };
  const set = (path: JSONPath, value: T): void => {
    const nodes = branch(path, true);
    const target = nodes.at(-1)!;
    const added = target.present ? 0 : 1;
    target.present = true;
    target.value = value;
    version++;
    for (const item of nodes) { item.size += added; item.version = version; }
  };
  const remove = (path: JSONPath): void => {
    const nodes = branch(path);
    if (nodes.length === 0) return;
    const size = nodes.at(-1)!.size;
    if (path.length === 0) { root.value = undefined; root.present = false; root.children.clear(); root.size = 0; } else nodes.at(-2)!.children.delete(path.at(-1)!);
    version++;
    for (const item of nodes.slice(0, -1)) { item.size -= size; item.version = version; }
    root.version = version;
  };
  const values = function* (path: JSONPath = []): Generator<T> {
    const target = find(path);
    if (target === undefined || target.size === 0) return;
    const visit = function* (item: JSONPathNode<T>): Generator<T> {
      if (item.present) yield item.value as T;
      for (const child of item.children.values()) if (child.size > 0) yield* visit(child);
    };
    yield* visit(target);
  };
  return { get, set, touch, delete: remove, values, within: (path: JSONPath): boolean => (find(path)?.size ?? 0) > 0, version: (path: JSONPath): number => find(path)?.version ?? 0 };
};
