import { expect, test } from 'vitest';

import { normalizeAzureChatCompletionsStream } from '../../../src/interceptors/openai-chat-completions/normalize-stream.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const frames = async function* (values: readonly ProtocolFrame<OpenAIChatCompletionsStreamEvent>[]) { yield* values; };

const collect = async <T>(values: AsyncIterable<T>): Promise<T[]> => {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
};

test('fails if an Azure prompt annotation never receives a response chunk', async () => {
  const annotation = eventFrame({
    id: '', object: '', created: 0, model: '', choices: [], usage: null,
    prompt_filter_results: [{ prompt_index: 0, content_filter_results: {} }],
  } as unknown as OpenAIChatCompletionsStreamEvent);

  await expect(collect(normalizeAzureChatCompletionsStream(frames([annotation, doneFrame()]))))
    .rejects.toThrow('prompt annotations ended without a response chunk');
});
