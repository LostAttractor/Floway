import type { IRPath, IRRecord } from './stream.ts';
import type { IRItem } from './types.ts';

const isIndex = (value: string | number | undefined): value is number => typeof value === 'number';

export const irPathKey = (path: IRPath): string => JSON.stringify(path);

export const irItemPath = (choice: number, item: number): IRPath => ['choices', choice, 'items', item];

export const irPartPath = (choice: number, item: number, part: number): IRPath => [...irItemPath(choice, item), 'content', part];

export const isIRItemPath = (path: IRPath): boolean => path.length === 4
  && path[0] === 'choices'
  && isIndex(path[1])
  && path[2] === 'items'
  && isIndex(path[3]);

export const isIRPartPath = (path: IRPath): boolean => path.length === 6 && isIRItemPath(path.slice(0, 4)) && path[4] === 'content' && isIndex(path[5]);

export const isIRAppendTarget = (path: IRPath, itemType?: IRItem['type']): boolean => {
  if (path[0] !== 'choices' || !isIndex(path[1]) || path[2] !== 'items' || !isIndex(path[3])) return false;
  if (path.length === 5) return (itemType === 'function_call' && path[4] === 'arguments') || (itemType === 'custom_tool_call' && path[4] === 'input');
  if (path.length === 6 && isIndex(path[5])) return itemType === 'reasoning' && (path[4] === 'summary' || path[4] === 'content');
  if (path.length === 7 && itemType === 'message' && path[4] === 'content' && isIndex(path[5])) return path[6] === 'text' || path[6] === 'refusal';
  return path.length === 8
    && itemType === 'message'
    && path[4] === 'content'
    && isIndex(path[5])
    && path[6] === 'audio'
    && (path[7] === 'data' || path[7] === 'transcript');
};

export const isIRNoneTarget = (path: IRPath, itemType?: IRItem['type']): boolean => (itemType === 'function_call' || itemType === 'custom_tool_call')
  && path.length === 5
  && isIRItemPath(path.slice(0, 4))
  && path[4] === 'call_id';

// The units a record belongs to, innermost first: a part and its item, or an item.
export const irRecordOwnerPaths = (record: IRRecord): readonly IRPath[] => {
  if (record.type === 'item_end') return [irItemPath(record.choice, record.item)];
  if (record.type === 'part_end') return [irPartPath(record.choice, record.item, record.part)];
  if (record.type !== 'operation' || record.path[0] !== 'choices' || record.path[2] !== 'items') return [];
  const item = record.path.slice(0, 4);
  return record.path[4] === 'content' && isIndex(record.path[5]) ? [record.path.slice(0, 6), item] : [item];
};
