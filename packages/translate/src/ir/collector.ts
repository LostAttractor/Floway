import { irItemPath, irPartPath, irPathKey, isIRAppendTarget, isIRItemPath, isIRNoneTarget, isIRPartPath } from './operation-paths.ts';
import type { IREvent, IROperation, IRPath } from './stream.ts';
import { IRNone, type IR, type IRAudioPart, type IRItem, type IRValue } from './types.ts';

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
  if (value === undefined) throw new TypeError(`Missing IR path: ${irPathKey(path)}`);
  return value;
};

const itemTypeAt = (state: IR, path: IRPath): IRItem['type'] | undefined => {
  if (path.length < 4 || !isIRItemPath(path.slice(0, 4))) return undefined;
  const item = valueAt(state, path.slice(0, 4));
  return item !== null && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string' ? (item as IRItem).type : undefined;
};

type IRValueVisitor = (path: IRPath, value: IRValue, itemType?: IRItem['type']) => void;

// Walks a value that is about to be written at `path`, telling the visitor the type of
// the item each node belongs to; a node's own `type` names the item at an item path.
const visit = (path: IRPath, value: IRValue, visitor: IRValueVisitor, itemType?: IRItem['type']): void => {
  if (value === undefined) throw new TypeError(`IR values cannot contain undefined: ${irPathKey(path)}`);
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const ownType = isIRItemPath(path) && isObject ? (value as { readonly type?: unknown }).type : undefined;
  const currentType = typeof ownType === 'string' ? ownType as IRItem['type'] : itemType;
  visitor(path, value, currentType);
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) visit([...path, Array.isArray(value) ? Number(key) : key], child as IRValue, visitor, currentType);
};

const validateInitialize = (path: IRPath, value: IRValue, itemType?: IRItem['type']): void => visit(path, value, (childPath, child, childItemType) => {
  if (isIRAppendTarget(childPath, childItemType) && child !== '') throw new TypeError(`IR append target must initialize to an empty string: ${irPathKey(childPath)}`);
  if (child === IRNone && !isIRNoneTarget(childPath, childItemType)) throw new TypeError(`IRNone is not allowed at ${irPathKey(childPath)}`);
}, itemType);

const validateAssign = (path: IRPath, value: IRValue, itemType?: IRItem['type']): void => visit(path, value, (childPath, child, childItemType) => {
  if (child === IRNone) throw new TypeError('IRNone must be assigned directly to call_id');
  if (isIRAppendTarget(childPath, childItemType)) throw new TypeError(`IR append target cannot be assigned: ${irPathKey(childPath)}`);
}, itemType);

const createCounter = <K>() => {
  const counts = new Map<K, number>();
  return {
    get: (key: K): number => counts.get(key) ?? 0,
    increment: (key: K): void => { counts.set(key, (counts.get(key) ?? 0) + 1); },
    decrement: (key: K): void => {
      const count = counts.get(key);
      if (count === undefined) throw new TypeError(`IR lifecycle counter underflow: ${String(key)}`);
      if (count === 1) counts.delete(key);
      else counts.set(key, count - 1);
    },
  };
};

// Tracks which items and parts are open or closed. Item and part paths never collide, so
// both live in the same sets.
const createLifecycle = () => {
  const open = new Set<string>();
  const closed = new Set<string>();
  const closedChoices = new Set<number>();
  const openItemsByChoice = createCounter<number>();
  const openPartsByItem = createCounter<string>();

  const assertWritable = (path: IRPath): void => {
    if (path[0] !== 'choices' || typeof path[1] !== 'number') return;
    if (closedChoices.has(path[1])) throw new TypeError(`IR operation targets a closed choice: ${irPathKey(path)}`);
    if (path.length >= 4 && closed.has(irPathKey(path.slice(0, 4)))) throw new TypeError(`IR operation targets a closed item: ${irPathKey(path)}`);
    if (path.length >= 6 && closed.has(irPathKey(path.slice(0, 6)))) throw new TypeError(`IR operation targets a closed part: ${irPathKey(path)}`);
  };

  const begin = (path: IRPath, value: IRValue): void => {
    if (isIRItemPath(path)) {
      open.add(irPathKey(path));
      openItemsByChoice.increment(path[1] as number);
    } else if (isIRPartPath(path) && value !== null && typeof value === 'object') {
      open.add(irPathKey(path));
      openPartsByItem.increment(irPathKey(path.slice(0, 4)));
    }
  };

  const endPart = (path: IRPath): void => {
    const key = irPathKey(path);
    if (!open.delete(key)) throw new TypeError(`IR part is not open: ${key}`);
    closed.add(key);
    openPartsByItem.decrement(irPathKey(path.slice(0, 4)));
  };

  const endItem = (choice: number, item: number): void => {
    const path = irItemPath(choice, item);
    const key = irPathKey(path);
    if (!open.delete(key)) throw new TypeError(`IR item is not open: ${key}`);
    if (openPartsByItem.get(key) !== 0) throw new TypeError(`IR item ended with an open part: ${key}`);
    closed.add(key);
    openItemsByChoice.decrement(choice);
  };

  const endChoice = (choice: number): void => {
    if (openItemsByChoice.get(choice) !== 0) throw new TypeError(`IR choice ${choice} ended with an open item`);
    if (closedChoices.has(choice)) throw new TypeError(`IR choice ${choice} ended twice`);
    closedChoices.add(choice);
  };

  const assertFinishable = (choiceCount: number): void => {
    if (open.size !== 0) throw new TypeError('IR finish arrived with open items');
    if (closedChoices.size !== choiceCount) throw new TypeError('IR finish arrived before every choice ended');
  };

  return {
    assertWritable,
    begin,
    endPart,
    endItem,
    endChoice,
    assertFinishable,
    isOpen: (path: IRPath): boolean => open.has(irPathKey(path)),
    isClosedItem: (path: IRPath): boolean => closed.has(irPathKey(path)),
  };
};

export const createIRCollector = () => {
  const state: IR = { choices: [] };
  // Containers created by this collector. Everything else is borrowed from a record and
  // is copied before its first write.
  const owned = new WeakSet<object>([state, state.choices]);
  const lifecycle = createLifecycle();

  const writableContainer = (path: IRPath): Record<string | number, unknown> => {
    let target = state as unknown as Record<string | number, unknown>;
    for (const segment of path) {
      const child = target[segment] as object;
      if (!owned.has(child)) {
        const copy = Array.isArray(child) ? [...child] : { ...child };
        owned.add(copy);
        Object.defineProperty(target, segment, { value: copy, writable: true, enumerable: true, configurable: true });
      }
      target = target[segment] as Record<string | number, unknown>;
    }
    return target;
  };

  // Returns whether the operation changed the state.
  const apply = (operation: IROperation): boolean => {
    if (operation.value === undefined) throw new TypeError('IR operations cannot carry undefined');
    lifecycle.assertWritable(operation.path);
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
    const current = (parent as Record<string | number, unknown>)[key];

    if (operation.operation === 'initialize') {
      validateInitialize(operation.path, operation.value, itemType);
    } else if (operation.operation === 'assign') {
      if (operation.value === IRNone) {
        if (!isIRNoneTarget(operation.path, itemType)) throw new TypeError(`IRNone is not allowed at ${irPathKey(operation.path)}`);
        if (present) throw new TypeError('IRNone may only be assigned to an absent target');
      } else validateAssign(operation.path, operation.value, itemType);
      if (present && Object.is(current, operation.value)) return false;
    } else {
      if (!isIRAppendTarget(operation.path, itemType)) throw new TypeError(`IR append requires an append-target path: ${irPathKey(operation.path)}`);
      if (typeof current !== 'string') throw new TypeError('IR append requires a string target');
      if (typeof operation.value !== 'string') throw new TypeError('IR append requires a string value');
      if (operation.value === '') return false;
    }

    const target = writableContainer(parentPath);
    if (operation.operation === 'append') target[key] = (target[key] as string) + operation.value;
    else Object.defineProperty(target, key, { value: operation.value, writable: true, enumerable: true, configurable: true });
    if (operation.operation === 'initialize') lifecycle.begin(operation.path, operation.value);
    return true;
  };

  const applyEvent = (event: IREvent): void => {
    switch (event.type) {
    case 'part_end': {
      const path = irPartPath(event.choice, event.item, event.part);
      if (!lifecycle.isOpen(path)) throw new TypeError(`IR part is not open: ${irPathKey(path)}`);
      const part = requireValueAt(state, path) as IRAudioPart;
      if (part.type === 'audio' && part.audio.data === undefined && part.audio.transcript === undefined) throw new TypeError('IR audio part requires data or transcript');
      lifecycle.endPart(path);
      return;
    }
    case 'item_end':
      lifecycle.endItem(event.choice, event.item);
      return;
    case 'choice_end':
      if (!Number.isInteger(event.choice) || event.choice < 0 || event.choice >= state.choices.length) throw new TypeError(`IR choice does not exist: ${event.choice}`);
      lifecycle.endChoice(event.choice);
      return;
    case 'finish':
      lifecycle.assertFinishable(state.choices.length);
      return;
    default:
    }
  };

  const value = <T = unknown>(path: IRPath): T | undefined => valueAt(state, path) as T | undefined;
  // A tool call that closed without a call ID has none to wait for.
  const optional = <T>(path: IRPath): T | typeof IRNone | undefined => {
    const actual = value<T | typeof IRNone>(path);
    if (actual !== undefined) return actual;
    return lifecycle.isClosedItem(path.slice(0, 4)) && isIRNoneTarget(path, itemTypeAt(state, path)) ? IRNone : undefined;
  };
  return { state, apply, applyEvent, value, isOpen: lifecycle.isOpen, optional };
};

export type IRCollector = ReturnType<typeof createIRCollector>;
