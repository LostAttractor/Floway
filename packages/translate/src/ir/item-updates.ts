import type { IRCollector } from './collector.ts';
import type { IRRecord } from './stream.ts';
import type { IRMessageItem } from './types.ts';

export const irChangedItems = (collector: IRCollector, record: IRRecord): Map<number, Set<number>> => {
  const result = new Map<number, Set<number>>();
  const addChoice = (choice: number, item?: number): void => {
    const items = collector.state.choices[choice]?.items;
    if (items === undefined) return;
    result.set(choice, new Set(item === undefined ? items.map((_, index) => index) : item < items.length ? [item] : []));
  };
  if (record.type === 'start' || record.type === 'finish') collector.state.choices.forEach((_, choice) => addChoice(choice));
  else if (record.type === 'choice_end') addChoice(record.choice);
  else if (record.type === 'item_start' || record.type === 'item_end' || record.type === 'part_start' || record.type === 'part_end') addChoice(record.choice, record.item);
  else if (record.type === 'operation') {
    const path = record.path;
    if (path[0] === 'choices') {
      if (typeof path[1] !== 'number') collector.state.choices.forEach((_, choice) => addChoice(choice));
      else if (path[2] === undefined || path[2] === 'items') addChoice(path[1], typeof path[3] === 'number' ? path[3] : undefined);
      else if (path[2] === 'logprobs') {
        const groups = collector.state.choices[path[1]]?.logprobs;
        const indices = typeof path[3] === 'number' ? [path[3]] : groups?.map((_, index) => index) ?? [];
        const items = new Set<number>();
        for (const index of indices) {
          const group = groups?.[index];
          const source = ['choices', path[1], 'logprobs', index];
          if (group?.scope === 'text_part' && collector.has([...source, 'scope']) && collector.has([...source, 'item_index']) && collector.has([...source, 'content_index'])) items.add(group.item_index);
        }
        result.set(path[1], items);
      }
    } else if (path[0] === 'extensions' && path[1] === 'openaiChatCompletions' && path[2] === 'choices') {
      if (typeof path[3] === 'number') addChoice(path[3]);
      else collector.state.choices.forEach((_, choice) => addChoice(choice));
    }
  }
  return result;
};

export const irChangedParts = (item: IRMessageItem, record: IRRecord, choice: number, index: number): readonly number[] => {
  if ((record.type === 'part_start' || record.type === 'part_end') && record.choice === choice && record.item === index) return [record.part];
  if (record.type === 'operation' && record.path[0] === 'choices' && record.path[1] === choice) {
    if (record.path[2] === 'items' && record.path[3] === index && record.path[4] === 'content' && typeof record.path[5] === 'number') return [record.path[5]];
  }
  return item.content.map((_, part) => part);
};
