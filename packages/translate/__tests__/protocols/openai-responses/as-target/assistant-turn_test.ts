import { describe, expect, expectTypeOf, it } from 'vitest';

import { toOpenAIResponsesInputAssistantTurn, type OpenAIResponsesAssistantState, type OpenAIResponsesOutputAssistantState } from '../../../../src/protocols/openai-responses/as-target/assistant-turn.ts';

interface TestStates { readonly text: string; readonly json: string }

describe('OpenAI Responses assistant turns', () => {
  it('keeps an incomplete function call when earlier items are filtered', () => {
    const turn = toOpenAIResponsesInputAssistantTurn([
      { type: 'additional_tools', id: 'tools', role: 'assistant', tools: [] },
      { type: 'function_call', id: 'call', call_id: 'call', name: 'lookup', arguments: '{}', status: 'incomplete' },
    ]);

    expect(turn).toEqual([{ type: 'function_call', id: 'call', call_id: 'call', name: 'lookup', arguments: '{}', status: 'incomplete' }]);
  });

  it('filters and reindexes sparse state with the same flatMap as the turn', () => {
    const outputState: OpenAIResponsesOutputAssistantState<TestStates> = [];
    outputState.length = 3;
    outputState[1] = { arguments: 'arguments-state' };
    const result = toOpenAIResponsesInputAssistantTurn<TestStates>([
      { type: 'additional_tools', id: 'tools', role: 'assistant', tools: [] },
      { type: 'function_call', id: 'call', call_id: 'call', name: 'lookup', arguments: '{}', status: 'incomplete' },
      { type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] },
    ], outputState);

    expectTypeOf(result.state).toEqualTypeOf<OpenAIResponsesAssistantState<TestStates>>();
    expect(result.turn).toEqual([
      { type: 'function_call', id: 'call', call_id: 'call', name: 'lookup', arguments: '{}', status: 'incomplete' },
      { type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] },
    ]);
    expect(result.state).toHaveLength(2);
    expect(result.state[0]).toEqual({ arguments: 'arguments-state' });
    expect(1 in result.state).toBe(false);
  });

  it('ignores inherited numeric properties when preserving sparse holes', () => {
    const state: OpenAIResponsesOutputAssistantState<TestStates> = [];
    state.length = 1;
    Object.setPrototypeOf(state, { 0: { arguments: 'inherited' } });
    const result = toOpenAIResponsesInputAssistantTurn<TestStates>([
      { type: 'function_call', call_id: 'call', name: 'lookup', arguments: '{}', status: 'completed' },
    ], state);

    expect(result.state).toHaveLength(1);
    expect(Object.hasOwn(result.state, 0)).toBe(false);
  });
});
