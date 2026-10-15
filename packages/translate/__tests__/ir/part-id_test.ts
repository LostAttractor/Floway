import { expect, test } from 'vitest';

import { createIRBuilder } from '../../src/ir/stream.ts';

test('carries optional source part IDs on append operations', () => {
  const builder = createIRBuilder();
  const item = builder.item(0, { type: 'message', content: [] });
  const part = item.part({ type: 'text', text: '' });
  builder.drain();

  part.append('text', 'first', 7);
  part.append('text', 'second');

  expect(builder.drain()).toEqual([
    { type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'first', partId: 7 },
    { type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'second' },
  ]);
});
