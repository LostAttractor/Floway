import { describe, expect, test } from 'vitest';

import { normalizeCopilotChatCompletionsStream } from '../../../src/interceptors/openai-chat-completions/normalize-stream.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const frames = async function* (values: readonly ProtocolFrame<OpenAIChatCompletionsStreamEvent>[]) { yield* values; };

const collect = async <T>(values: AsyncIterable<T>): Promise<T[]> => {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
};

const chunk = (value: Record<string, unknown>): ProtocolFrame<OpenAIChatCompletionsStreamEvent> =>
  eventFrame(value as unknown as OpenAIChatCompletionsStreamEvent);

describe('Copilot ChatCompletions stream normalization', () => {
  test('carries prompt annotations and restores the stable ChatCompletions envelope', async () => {
    const promptFilterResults = [{ prompt_index: 0, content_filter_results: { hate: { filtered: false } } }];
    const contentFilterResults = { hate: { filtered: false, severity: 'safe' } };
    const output = await collect(normalizeCopilotChatCompletionsStream(frames([
      chunk({ id: '', created: 5, model: 'gpt-4o', choices: [], prompt_filter_results: promptFilterResults }),
      chunk({ id: 'chatcmpl-copilot', created: 10, model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
      chunk({ id: 'chatcmpl-copilot', created: 11, model: 'gpt-4o', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null, content_filter_results: contentFilterResults }] }),
      chunk({ id: 'chatcmpl-copilot', created: 12, model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      chunk({ id: 'chatcmpl-copilot', created: 13, model: 'gpt-4o', choices: [], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } }),
      doneFrame(),
    ])));

    const events = output.flatMap(frame => frame.type === 'event' ? [frame.event as unknown as Record<string, any>] : []);
    expect(events).toHaveLength(4);
    expect(events.map(({ id, object, created, model }) => ({ id, object, created, model }))).toEqual(Array.from({ length: 4 }, () => ({
      id: 'chatcmpl-copilot',
      object: 'chat.completion.chunk',
      created: 10,
      model: 'gpt-4o',
    })));
    expect(events[0]?.prompt_filter_results).toEqual(promptFilterResults);
    expect(events[1]?.choices[0]).toMatchObject({ delta: { content: 'answer' }, content_filter_results: contentFilterResults });
    expect(events[3]?.choices).toEqual([]);
    expect(events[3]?.usage).toEqual({ prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 });
    expect(output.at(-1)).toEqual(doneFrame());
  });

  test('fails if prompt annotations never receive a response identity', async () => {
    await expect(collect(normalizeCopilotChatCompletionsStream(frames([
      chunk({ id: '', created: 5, model: 'gpt-4o', choices: [], prompt_filter_results: [] }),
      doneFrame(),
    ])))).rejects.toThrow('prompt annotations ended without a response chunk');
  });

  test('fails if the stream ends naturally before a response identity arrives', async () => {
    await expect(collect(normalizeCopilotChatCompletionsStream(frames([
      chunk({ id: '', created: 5, model: 'gpt-4o', choices: [], prompt_filter_results: [] }),
    ])))).rejects.toThrow('prompt annotations ended without a response chunk');
  });

  test('keeps rejecting response identity changes after normalization', async () => {
    await expect(collect(normalizeCopilotChatCompletionsStream(frames([
      chunk({ id: 'chatcmpl-first', created: 10, model: 'gpt-4o', choices: [{ index: 0, delta: { content: 'A' }, finish_reason: null }] }),
      chunk({ id: 'chatcmpl-second', created: 11, model: 'gpt-4o', choices: [{ index: 0, delta: { content: 'B' }, finish_reason: null }] }),
    ])))).rejects.toThrow('response id changed from chatcmpl-first to chatcmpl-second');
  });
});
