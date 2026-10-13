import { expect, test } from 'vitest';

import { computeGeminiGenerateContentReplayCheck } from '../../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { buildTargetRequest as viaMessages } from '../../../src/protocols/gemini-generate-content/via-anthropic-messages/request.ts';
import { buildTargetRequest as viaChat } from '../../../src/protocols/gemini-generate-content/via-openai-chat-completions/request.ts';
import { buildTargetRequest as viaResponses } from '../../../src/protocols/gemini-generate-content/via-openai-responses/request.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';

const assistantTurn: GeminiGenerateContentContent[] = [{ role: 'model', parts: [{ functionCall: { name: 'lookup', args: { query: 'docs' } } }] }];
const replayedContents = (carrier: string): GeminiGenerateContentContent[] => [
  { role: 'user', parts: [{ text: 'question' }] },
  { role: 'model', parts: [{ thoughtSignature: carrier, functionCall: { name: 'lookup', args: { query: 'docs' } } }] },
  { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { answer: 42 } } }] },
  { role: 'model', parts: [{ functionCall: { name: 'other', args: {} } }] },
];

test('Gemini via Chat uses restored call IDs for id-less responses and original indices for later bare calls', async () => {
  const codec = createTestSidecarCodec();
  const native = { role: 'assistant' as const, tool_calls: [{ id: 'native-chat-call', type: 'function' as const, function: { name: 'lookup', arguments: '{"query":"docs"}' } }] };
  const carrier = await codec.encode('geminiGenerateContent', { target: 'openaiChatCompletions', assistantTurn: native, replayCheck: await computeGeminiGenerateContentReplayCheck(assistantTurn) });
  const request = await viaChat({ contents: replayedContents(carrier) }, 'test', codec);
  expect(request.messages).toEqual([
    { role: 'user', content: 'question' },
    native,
    { role: 'tool', tool_call_id: 'native-chat-call', content: '{"answer":42}' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'gemini_call_3_0', type: 'function', function: { name: 'other', arguments: '{}' } }] },
  ]);
});

test('Gemini via Messages uses restored call IDs without adding cache metadata to native history', async () => {
  const codec = createTestSidecarCodec();
  const native = { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'native-messages-call', name: 'lookup', input: { query: 'docs' } }] };
  const carrier = await codec.encode('geminiGenerateContent', { target: 'anthropicMessages', assistantTurn: native, replayCheck: await computeGeminiGenerateContentReplayCheck(assistantTurn) });
  const request = await viaMessages({ contents: replayedContents(carrier) }, 'test', codec, { fallbackMaxOutputTokens: undefined });
  expect(request.messages[1]).toEqual(native);
  expect(request.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native-messages-call', content: '{"answer":42}' }] });
  expect(request.messages[3]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'gemini_call_3_0', name: 'other', input: {}, cache_control: { type: 'ephemeral' } }] });
});

test('Gemini via Responses uses restored call IDs and preserves later bare call positions', async () => {
  const codec = createTestSidecarCodec();
  const native = [{ type: 'function_call' as const, call_id: 'native-responses-call', name: 'lookup', arguments: '{"query":"docs"}', status: 'completed' as const }];
  const carrier = await codec.encode('geminiGenerateContent', { target: 'openaiResponses', assistantTurn: native, replayCheck: await computeGeminiGenerateContentReplayCheck(assistantTurn) });
  const request = await viaResponses({ contents: replayedContents(carrier) }, 'test', codec);
  expect(request.input).toEqual([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] },
    ...native,
    { type: 'function_call_output', call_id: 'native-responses-call', output: '{"answer":42}', status: 'completed' },
    { type: 'function_call', call_id: 'gemini_call_3_0', name: 'other', arguments: '{}', status: 'completed' },
  ]);
});
