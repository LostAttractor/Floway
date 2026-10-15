import { expect, test } from 'vitest';

import { createIRBuilder } from '../../../../src/ir/stream.ts';
import { geminiGenerateContentFromIR } from '../../../../src/protocols/gemini-generate-content/as-source/sse-to.ts';
import type { RoundTripWriter } from '../../../../src/round-trip/stream.ts';
import { appendField, collectContentViews, createReferenceBuilder, createFieldState, createReferenceFinalizer } from '../../../../src/round-trip/thin/reference-builder.ts';

test('keeps Gemini text and thought content state aligned with accumulated parts', async () => {
  const references = createReferenceBuilder();
  const field = (parts: readonly string[], restoration: 'text' | 'json' = 'text') => {
    const state = createFieldState(restoration);
    return { state, partIds: parts.map(part => appendField(references, state, part)), original: parts.join('') };
  };
  const text = field(['A', 'B']);
  const reasoning = field(['S', 'C']);
  const argumentsField = field(['{"x":', '1}'], 'json');
  const audioData = field(['YQ==']);
  const transcript = field(['spoken ', 'text']);
  let prepared = false;
  const roundTrip: RoundTripWriter<'geminiGenerateContent'> = {
    builder: references,
    prepareSidecar: async (_choice, _replayCheck, turn, state) => {
      expect(turn[0].parts).toEqual([
        { text: 'AB' },
        { text: 'S', thought: true },
        { text: 'C', thought: true },
        { functionCall: { name: 'lookup', id: 'call', args: { x: 1 } } },
        { inlineData: { mimeType: 'audio/wav', data: 'YQ==' }, audioTranscription: { text: 'spoken text' } },
      ]);
      expect(state[0]?.parts).toMatchObject([
        { text: {} },
        undefined,
        undefined,
        { functionCall: { args: {} } },
        { inlineData: { data: {} }, audioTranscription: { text: {} } },
      ]);

      const finalizer = await createReferenceFinalizer(references, collectContentViews(turn, state));
      expect(await finalizer.finalizeField(text.original, text.state)).not.toBe(text.original);
      expect(await finalizer.finalizeField(reasoning.original, reasoning.state)).toBe(reasoning.original);
      expect(await finalizer.finalizeField({ x: 1 }, argumentsField.state)).not.toEqual({ x: 1 });
      expect(await finalizer.finalizeField(audioData.original, audioData.state)).not.toBe(audioData.original);
      expect(await finalizer.finalizeField(transcript.original, transcript.state)).not.toBe(transcript.original);
      prepared = true;
      return 'sidecar';
    },
  };

  const builder = createIRBuilder();
  builder.choice(0);
  builder.assign(['model'], 'model');
  builder.event({ type: 'start', id: 'response' });
  builder.initialize(['choices', 0, 'items', 0], { type: 'message', content: [] });
  builder.initialize(['choices', 0, 'items', 0, 'content', 0], { type: 'text', text: '' });
  builder.append(['choices', 0, 'items', 0, 'content', 0, 'text'], 'A', text.partIds[0]);
  builder.append(['choices', 0, 'items', 0, 'content', 0, 'text'], 'B', text.partIds[1]);
  builder.event({ type: 'part_end', choice: 0, item: 0, part: 0 });
  builder.event({ type: 'item_end', choice: 0, item: 0 });
  builder.initialize(['choices', 0, 'items', 1], { type: 'reasoning', summary: [''], content: [''] });
  builder.append(['choices', 0, 'items', 1, 'summary', 0], 'S', reasoning.partIds[0]);
  builder.append(['choices', 0, 'items', 1, 'content', 0], 'C', reasoning.partIds[1]);
  builder.event({ type: 'item_end', choice: 0, item: 1 });
  builder.initialize(['choices', 0, 'items', 2], { type: 'function_call', call_id: 'call', name: 'lookup', arguments: '' });
  builder.append(['choices', 0, 'items', 2, 'arguments'], '{"x":', argumentsField.partIds[0]);
  builder.append(['choices', 0, 'items', 2, 'arguments'], '1}', argumentsField.partIds[1]);
  builder.event({ type: 'item_end', choice: 0, item: 2 });
  builder.initialize(['choices', 0, 'items', 3], { type: 'message', content: [] });
  builder.initialize(['choices', 0, 'items', 3, 'content', 0], { type: 'audio', audio: { mime_type: 'audio/wav' } });
  builder.initialize(['choices', 0, 'items', 3, 'content', 0, 'audio', 'data'], '');
  builder.initialize(['choices', 0, 'items', 3, 'content', 0, 'audio', 'transcript'], '');
  builder.append(['choices', 0, 'items', 3, 'content', 0, 'audio', 'data'], 'YQ==', audioData.partIds[0]);
  builder.append(['choices', 0, 'items', 3, 'content', 0, 'audio', 'transcript'], 'spoken ', transcript.partIds[0]);
  builder.append(['choices', 0, 'items', 3, 'content', 0, 'audio', 'transcript'], 'text', transcript.partIds[1]);
  builder.event({ type: 'part_end', choice: 0, item: 3, part: 0 });
  builder.event({ type: 'item_end', choice: 0, item: 3 });
  builder.event({ type: 'choice_end', choice: 0, finish_reason: 'tool_calls' });
  builder.event({ type: 'finish', status: 'completed' });

  for await (const _frame of geminiGenerateContentFromIR((async function* () { yield* builder.drain(); })(), { roundTrip })) {}
  expect(prepared).toBe(true);
});
