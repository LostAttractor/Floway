import { expect, test } from 'vitest';

import { createJSONPathIndex } from '../../../src/shared/json/path-index.ts';

test('path branches retain independent revisions and replacing one subtree leaves siblings intact', () => {
  const index = createJSONPathIndex<string>();
  index.set(['a', 0, 'text'], 'first');
  index.set(['b', '0', 'text'], 'second');
  const version = index.version(['b']);
  index.delete(['a']);
  expect(index.within(['a'])).toBe(false);
  expect(index.version(['b'])).toBe(version);
  expect([...index.values(['b'])]).toEqual(['second']);
  index.set(['a'], 'replacement');
  expect([...index.values(['a'])]).toEqual(['replacement']);
  expect(index.get(['a', 0, 'text'])).toBeUndefined();
  expect(index.within(['b', 0])).toBe(false);
});

test('stored undefined is distinct from an absent branch for enumeration and subtree presence', () => {
  const index = createJSONPathIndex<undefined>();
  index.set(['present'], undefined);
  index.set(['present'], undefined);
  expect(index.within(['present'])).toBe(true);
  expect([...index.values()]).toEqual([undefined]);
  index.delete([]);
  expect(index.within([])).toBe(false);
  expect([...index.values()]).toEqual([]);
});
