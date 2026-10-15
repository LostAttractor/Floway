import { describe, expect, expectTypeOf, it } from 'vitest';

import { toOpenAIChatCompletionsInputAssistantTurn, type OpenAIChatCompletionsAssistantState, type OpenAIChatCompletionsOutputAssistantState, type OpenAIChatCompletionsThinAssistantTurn } from '../../../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import type { ThinState, TextRule } from '../../../../src/round-trip/thin/assistant-turn.ts';

interface TestReference { readonly id: string }
interface TestStates { readonly text: string; readonly json: string }

describe('OpenAI Chat Completions assistant turns', () => {
  it('preserves the input shape while thinning selected text fields', () => {
    type Reference = TestReference;
    type Input = OpenAIChatCompletionsThinAssistantTurn<Reference>;
    type ContentPart = Extract<NonNullable<Input['content']>, unknown[]>[number];

    expectTypeOf<Input['audio']>().toEqualTypeOf<{ id: string } | null | undefined>();
    expectTypeOf<Extract<Input['content'], Reference>>().toEqualTypeOf<Reference>();
    expectTypeOf<Extract<ContentPart, { type: 'text' }>['text']>().toEqualTypeOf<string | Reference>();
    expectTypeOf<Extract<ContentPart, { type: 'refusal' }>['refusal']>().toEqualTypeOf<string | Reference>();
    expectTypeOf<Input['function_call']>().toEqualTypeOf<{ name: string; arguments: string | Reference } | null | undefined>();
    expectTypeOf<Extract<NonNullable<Input['tool_calls']>[number], { type: 'function' }>['function']['arguments']>().toEqualTypeOf<string | Reference>();
    expectTypeOf<Extract<NonNullable<Input['tool_calls']>[number], { type: 'custom' }>['custom']['input']>().toEqualTypeOf<string | Reference>();

    type SparseState = ThinState<{
      items: { text: string; ignored: number }[];
      ignored: string;
    }, {
      items: [{ text: TextRule }];
    }, { text: 'state'; json: never }>;
    expectTypeOf<SparseState>().toEqualTypeOf<{
      items?: ({ text?: 'state' } | undefined)[];
    }>();
  });

  it('converts output audio to its input ID', () => {
    const turn = toOpenAIChatCompletionsInputAssistantTurn({
      role: 'assistant',
      content: 'content',
      refusal: null,
      audio: { id: 'audio', data: 'bytes', expires_at: 1, transcript: 'hello' },
    });

    expect(turn).toEqual({ role: 'assistant', content: 'content', refusal: null, audio: { id: 'audio' } });
  });

  it('converts output audio while preserving the corresponding sparse state', () => {
    const toolCalls: NonNullable<OpenAIChatCompletionsOutputAssistantState<TestStates>['tool_calls']> = [];
    toolCalls.length = 2;
    toolCalls[1] = { function: { arguments: 'arguments-state' } };
    const outputState = {
      content: 'content-state',
      tool_calls: toolCalls,
    } satisfies OpenAIChatCompletionsOutputAssistantState<TestStates>;
    const result = toOpenAIChatCompletionsInputAssistantTurn<TestStates>({
      role: 'assistant',
      content: 'content',
      refusal: null,
      audio: { id: 'audio', data: 'bytes', expires_at: 1, transcript: 'hello' },
    }, outputState);

    expectTypeOf(result.state).toEqualTypeOf<OpenAIChatCompletionsAssistantState<TestStates>>();
    expect(result.turn).toEqual({ role: 'assistant', content: 'content', refusal: null, audio: { id: 'audio' } });
    expect(result.state).toEqual(outputState);
    expect(result.state).not.toBe(outputState);
    const toolCallsState = result.state.tool_calls;
    if (toolCallsState === undefined) throw new Error('Expected tool-call state');
    expect(0 in toolCallsState).toBe(false);
    expect(toolCallsState[1]).toEqual({ function: { arguments: 'arguments-state' } });
  });
});
