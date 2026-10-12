import { isIRAppendTarget, isIRNoneTarget } from './operation-paths.ts';
import type { IREvent, IROperation, IRPath } from './stream.ts';
import { IRNone, type IR, type IRAudioPart, type IRItem, type IRValue } from './types.ts';

const pathKey = (path: IRPath): string => JSON.stringify(path);

const valueAt = (root: unknown, path: IRPath): unknown => {
  let value = root;
  for (const key of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
};

const requireValueAt = (root: unknown, path: IRPath): unknown => {
  const value = valueAt(root, path);
  if (value === undefined) throw new TypeError(`Missing IR path: ${JSON.stringify(path)}`);
  return value;
};

const visit = (path: IRPath, value: IRValue, callback: (path: IRPath, value: IRValue, itemType?: IRItem['type']) => void, inheritedItemType?: IRItem['type']): void => {
  if (value === undefined) throw new TypeError(`IR values cannot contain undefined: ${JSON.stringify(path)}`);
  const itemObject = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as { readonly type?: unknown } : undefined;
  const itemType = path.length === 4 && path[0] === 'choices' && path[2] === 'items' && typeof itemObject?.type === 'string'
    ? itemObject.type as IRItem['type']
    : inheritedItemType;
  callback(path, value, itemType);
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) visit([...path, Array.isArray(value) ? Number(key) : key], child as IRValue, callback, itemType);
};

const validateInitialize = (path: IRPath, value: IRValue, itemType?: IRItem['type']): void => visit(path, value, (childPath, child, childItemType) => {
  if (isIRAppendTarget(childPath, childItemType) && child !== '') throw new TypeError(`IR append target must initialize to an empty string: ${JSON.stringify(childPath)}`);
  if (child === IRNone && !isIRNoneTarget(childPath, childItemType)) throw new TypeError(`IRNone is not allowed at ${JSON.stringify(childPath)}`);
}, itemType);

const validateAssign = (path: IRPath, value: IRValue, itemType?: IRItem['type']): void => visit(path, value, (childPath, child, childItemType) => {
  if (child === IRNone) throw new TypeError('IRNone must be assigned directly to call_id');
  if (isIRAppendTarget(childPath, childItemType)) throw new TypeError(`IR append target cannot be assigned: ${JSON.stringify(childPath)}`);
}, itemType);

const itemPath = (choice: number, item: number): IRPath => ['choices', choice, 'items', item];
const partPath = (choice: number, item: number, part: number): IRPath => [...itemPath(choice, item), 'content', part];
const itemTypeAt = (state: IR, path: IRPath): IRItem['type'] | undefined => {
  if (path[0] !== 'choices' || typeof path[1] !== 'number' || path[2] !== 'items' || typeof path[3] !== 'number') return undefined;
  const item = valueAt(state, path.slice(0, 4));
  return item !== null && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string' ? (item as IRItem).type : undefined;
};
export const createIRCollector = () => {
  const state: IR = { choices: [] };
  const owned = new WeakSet<object>([state, state.choices]);
  const openItems = new Set<string>();
  const closedItems = new Set<string>();
  const openParts = new Set<string>();
  const closedParts = new Set<string>();
  const closedChoices = new Set<number>();
  const openItemsByChoice = new Map<number, number>();
  const openPartsByItem = new Map<string, number>();

  const assertOpenTarget = (path: IRPath): void => {
    if (path[0] !== 'choices' || typeof path[1] !== 'number') return;
    if (closedChoices.has(path[1])) throw new TypeError(`IR operation targets a closed choice: ${JSON.stringify(path)}`);
    if (path[2] !== 'items' || typeof path[3] !== 'number') return;
    const item = pathKey(path.slice(0, 4));
    if (closedItems.has(item)) throw new TypeError(`IR operation targets a closed item: ${JSON.stringify(path)}`);
    if (path[4] !== 'content' || typeof path[5] !== 'number') return;
    const part = pathKey(path.slice(0, 6));
    if (closedParts.has(part)) throw new TypeError(`IR operation targets a closed part: ${JSON.stringify(path)}`);
  };

  const apply = (operation: IROperation): boolean => {
    if (operation.value === undefined) throw new TypeError('IR operations cannot carry undefined');
    assertOpenTarget(operation.path);
    const key = operation.path.at(-1);
    if (key === undefined) throw new TypeError('IR operations require a property path');
    const parentPath = operation.path.slice(0, -1);
    const parent = requireValueAt(state, parentPath);
    if (typeof parent !== 'object' || parent === null) throw new TypeError('IR operation parent must be an object or array');
    const present = Object.hasOwn(parent, key);
    const itemType = itemTypeAt(state, operation.path);
    if (operation.operation === 'initialize' && present) throw new TypeError('IR initialize requires an absent target');
    if (Array.isArray(parent)) {
      if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > parent.length) throw new TypeError('IR array operation requires a contiguous nonnegative index');
      if (!present && key !== parent.length) throw new TypeError('IR array insertion must use the next index');
      if (operation.operation === 'initialize' && key !== parent.length) throw new TypeError('IR array initialization must use the next index');
    }
    if (operation.operation === 'initialize') {
      validateInitialize(operation.path, operation.value, itemType);
    } else if (operation.operation === 'assign') {
      if (operation.value === IRNone) {
        if (!isIRNoneTarget(operation.path, itemType)) throw new TypeError(`IRNone is not allowed at ${JSON.stringify(operation.path)}`);
        if (present) throw new TypeError('IRNone may only be assigned to an absent target');
      } else validateAssign(operation.path, operation.value, itemType);
    } else {
      const targetValue = (parent as Record<string | number, unknown>)[key];
      if (!isIRAppendTarget(operation.path, itemType)) throw new TypeError(`IR append requires an append-target path: ${JSON.stringify(operation.path)}`);
      if (typeof targetValue !== 'string') throw new TypeError('IR append requires a string target');
      if (typeof operation.value !== 'string') throw new TypeError('IR append requires a string value');
      if (operation.value === '') return false;
    }
    if (operation.operation === 'assign' && present && Object.is((parent as Record<string | number, unknown>)[key], operation.value)) return false;

    let target = state as unknown as Record<string | number, unknown>;
    for (const segment of parentPath) {
      const child = target[segment] as object;
      if (!owned.has(child)) {
        const copy = Array.isArray(child) ? [...child] : { ...child };
        owned.add(copy);
        Object.defineProperty(target, segment, { value: copy, writable: true, enumerable: true, configurable: true });
      }
      target = target[segment] as Record<string | number, unknown>;
    }
    if (operation.operation === 'append') target[key] = (target[key] as string) + operation.value;
    else Object.defineProperty(target, key, { value: operation.value, writable: true, enumerable: true, configurable: true });

    if (operation.operation === 'initialize') {
      if (operation.path.length === 4 && operation.path[0] === 'choices' && typeof operation.path[1] === 'number' && operation.path[2] === 'items') {
        openItems.add(pathKey(operation.path));
        openItemsByChoice.set(operation.path[1], (openItemsByChoice.get(operation.path[1]) ?? 0) + 1);
      }
      if (operation.path.length === 6 && operation.path[0] === 'choices' && operation.path[2] === 'items' && operation.path[4] === 'content' && operation.value !== null && typeof operation.value === 'object') {
        const part = pathKey(operation.path);
        const item = pathKey(operation.path.slice(0, 4));
        openParts.add(part);
        openPartsByItem.set(item, (openPartsByItem.get(item) ?? 0) + 1);
      }
    }
    return true;
  };

  const applyEvent = (event: IREvent): void => {
    if (event.type === 'part_end') {
      const path = partPath(event.choice, event.item, event.part);
      const key = pathKey(path);
      if (!openParts.delete(key)) throw new TypeError(`IR part is not open: ${JSON.stringify(path)}`);
      const part = requireValueAt(state, path);
      if ((part as IRAudioPart).type === 'audio' && (part as IRAudioPart).audio.data === undefined && (part as IRAudioPart).audio.transcript === undefined) throw new TypeError('IR audio part requires data or transcript');
      closedParts.add(key);
      const item = pathKey(path.slice(0, 4));
      const openCount = openPartsByItem.get(item);
      if (openCount === undefined || openCount <= 0) throw new TypeError(`IR item has no open-part count: ${JSON.stringify(path.slice(0, 4))}`);
      const remaining = openCount - 1;
      if (remaining === 0) openPartsByItem.delete(item); else openPartsByItem.set(item, remaining);
    } else if (event.type === 'item_end') {
      const path = itemPath(event.choice, event.item);
      const key = pathKey(path);
      if (!openItems.delete(key)) throw new TypeError(`IR item is not open: ${JSON.stringify(path)}`);
      if ((openPartsByItem.get(key) ?? 0) !== 0) throw new TypeError(`IR item ended with an open part: ${JSON.stringify(path)}`);
      closedItems.add(key);
      const openCount = openItemsByChoice.get(event.choice);
      if (openCount === undefined || openCount <= 0) throw new TypeError(`IR choice has no open-item count: ${event.choice}`);
      const remaining = openCount - 1;
      if (remaining === 0) openItemsByChoice.delete(event.choice); else openItemsByChoice.set(event.choice, remaining);
    } else if (event.type === 'choice_end') {
      if (!Number.isInteger(event.choice) || event.choice < 0 || event.choice >= state.choices.length) throw new TypeError(`IR choice does not exist: ${event.choice}`);
      if ((openItemsByChoice.get(event.choice) ?? 0) !== 0) throw new TypeError(`IR choice ${event.choice} ended with an open item`);
      if (closedChoices.has(event.choice)) throw new TypeError(`IR choice ${event.choice} ended twice`);
      closedChoices.add(event.choice);
    } else if (event.type === 'finish') {
      if (openItems.size !== 0) throw new TypeError('IR finish arrived with open items');
      if (closedChoices.size !== state.choices.length) throw new TypeError('IR finish arrived before every choice ended');
    }
  };

  const value = <T = unknown>(path: IRPath): T | undefined => valueAt(state, path) as T | undefined;
  const isOpen = (path: IRPath): boolean => {
    const key = pathKey(path);
    return openItems.has(key) || openParts.has(key);
  };
  const optional = <T>(path: IRPath): T | typeof IRNone | undefined => {
    const actual = value<T | typeof IRNone>(path);
    if (actual !== undefined) return actual;
    return closedItems.has(pathKey(path.slice(0, 4))) && isIRNoneTarget(path, itemTypeAt(state, path)) ? IRNone : undefined;
  };
  return { state, apply, applyEvent, value, isOpen, optional };
};

export type IRCollector = ReturnType<typeof createIRCollector>;
