import type { IRRecord } from './stream.ts';
import type { IRMessageItem, IRContentPart } from './types.ts';

interface IRMessageLayout { types: IRContentPart['type'][]; groups: number[]; positions: number[]; nonText: number }
const isText = (type: IRContentPart['type']): boolean => type === 'text' || type === 'refusal';

export const createIRMessageLayouts = () => {
  const layouts = new Map<string, IRMessageLayout>();
  return (item: IRMessageItem, record: IRRecord, choice: number, index: number) => {
    const key = `${choice}/${index}`;
    let layout = layouts.get(key);
    if (layout === undefined) { layout = { types: [], groups: [], positions: [], nonText: 0 }; layouts.set(key, layout); }
    const source = ['choices', choice, 'items', index, 'content'];
    let start = layout.types.length;
    if (record.type === 'operation' && record.path.length <= source.length && record.path.every((key, p) => key === source[p]) || item.content.length < layout.types.length) start = 0;
    if (record.type === 'operation' && source.every((key, p) => key === record.path[p]) && typeof record.path[5] === 'number' && (record.path.length === 6 || record.path.length === 7 && record.path[6] === 'type')) {
      const part = record.path[5];
      if (layout.types[part] !== item.content[part].type) start = Math.min(start, part);
    }
    for (let p = item.content.length; p < layout.types.length; p++) if (!isText(layout.types[p])) layout.nonText--;
    for (let p = start; p < item.content.length; p++) {
      if (layout.types[p] !== undefined && !isText(layout.types[p])) layout.nonText--;
      layout.types[p] = item.content[p].type;
      if (!isText(layout.types[p])) layout.nonText++;
      layout.groups[p] = p === 0 ? 0 : layout.groups[p - 1] + (isText(layout.types[p - 1]) ? 0 : 1);
      layout.positions[p] = p === 0 || !isText(layout.types[p - 1]) ? 0 : layout.positions[p - 1] + 1;
    }
    layout.types.length = layout.groups.length = layout.positions.length = item.content.length;
    return { groups: layout.groups as readonly number[], positions: layout.positions as readonly number[], textOnly: layout.nonText === 0 };
  };
};
