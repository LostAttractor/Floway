import { expect, test } from 'vitest';

import { createIRBuilder } from '../../../../src/ir/stream.ts';
import { openaiChatCompletionsFromIR } from '../../../../src/protocols/openai-chat-completions/as-source/sse-to.ts';
import type { RoundTripWriter } from '../../../../src/round-trip/stream.ts';
import { collectContentViews, createReferenceBuilder, createFieldState, createReferenceFinalizer, appendField } from '../../../../src/round-trip/thin/reference-builder.ts';

test('collects sparse ChatCompletions output state from emitted IR atoms', async () => {
  const references = createReferenceBuilder();
  const field = (parts: readonly string[]) => {
    const state = createFieldState('text');
    const partIds = parts.map(part => appendField(references, state, part));
    return { state, partIds, original: parts.join('') };
  };
  const content = field(['A', 'B']);
  const reasoning = field(['S', 'C']);
  const functionArguments = field(['{"x":', '1}']);
  const customInput = field(['run', '()']);
  const transcript = field(['spoken ', 'text']);
  let prepared: Parameters<RoundTripWriter<'openaiChatCompletions'>['prepareSidecar']> | undefined;
  const roundTrip: RoundTripWriter<'openaiChatCompletions'> = {
    builder: references,
    prepareSidecar: async (...args) => {
      prepared = args;
      return 'sidecar';
    },
  };

  const builder = createIRBuilder();
  builder.choice(0);
  builder.assign(['model'], 'model');
  builder.event({ type: 'start', id: 'response' });

  builder.initialize(['choices', 0, 'items', 0], { type: 'message', content: [] });
  builder.initialize(['choices', 0, 'items', 0, 'content', 0], { type: 'text', text: '' });
  builder.append(['choices', 0, 'items', 0, 'content', 0, 'text'], 'A', content.partIds[0]);
  builder.append(['choices', 0, 'items', 0, 'content', 0, 'text'], 'B', content.partIds[1]);
  builder.event({ type: 'part_end', choice: 0, item: 0, part: 0 });
  builder.event({ type: 'item_end', choice: 0, item: 0 });

  builder.initialize(['choices', 0, 'items', 1], { type: 'reasoning', summary: [''], content: [''] });
  builder.append(['choices', 0, 'items', 1, 'summary', 0], 'S', reasoning.partIds[0]);
  builder.append(['choices', 0, 'items', 1, 'content', 0], 'C', reasoning.partIds[1]);
  builder.event({ type: 'item_end', choice: 0, item: 1 });

  builder.initialize(['choices', 0, 'items', 2], { type: 'function_call', call_id: 'function', name: 'lookup', arguments: '' });
  builder.append(['choices', 0, 'items', 2, 'arguments'], '{"x":', functionArguments.partIds[0]);
  builder.append(['choices', 0, 'items', 2, 'arguments'], '1}', functionArguments.partIds[1]);
  builder.event({ type: 'item_end', choice: 0, item: 2 });

  builder.initialize(['choices', 0, 'items', 3], { type: 'custom_tool_call', call_id: 'custom', name: 'script', input: '' });
  builder.append(['choices', 0, 'items', 3, 'input'], 'run', customInput.partIds[0]);
  builder.append(['choices', 0, 'items', 3, 'input'], '()', customInput.partIds[1]);
  builder.event({ type: 'item_end', choice: 0, item: 3 });

  builder.initialize(['choices', 0, 'items', 4], { type: 'message', content: [] });
  builder.initialize(['choices', 0, 'items', 4, 'content', 0], { type: 'audio', audio: {} });
  builder.initialize(['choices', 0, 'items', 4, 'content', 0, 'audio', 'transcript'], '');
  builder.append(['choices', 0, 'items', 4, 'content', 0, 'audio', 'transcript'], 'spoken ', transcript.partIds[0]);
  builder.append(['choices', 0, 'items', 4, 'content', 0, 'audio', 'transcript'], 'text', transcript.partIds[1]);
  builder.event({ type: 'part_end', choice: 0, item: 4, part: 0 });
  builder.event({ type: 'item_end', choice: 0, item: 4 });

  builder.assign(['choices', 0, 'refusal'], { category: null, explanation: 'explanation' });
  builder.event({ type: 'choice_end', choice: 0, finish_reason: 'tool_calls' });
  builder.event({ type: 'finish', status: 'completed' });

  for await (const _frame of openaiChatCompletionsFromIR((async function* () { yield* builder.drain(); })(), { roundTrip })) {}
  if (prepared === undefined) throw new Error('ChatCompletions sidecar was not prepared');
  const [, , turn, state] = prepared;

  expect(turn).toMatchObject({
    role: 'assistant',
    content: 'ABspoken text',
    refusal: 'explanation',
    reasoning_text: 'SC',
    tool_calls: [
      { type: 'function', function: { arguments: '{"x":1}' } },
      { type: 'custom', custom: { input: 'run()' } },
    ],
  });
  expect(state).toMatchObject({
    content: {},
    refusal: {},
    reasoning_text: {},
    tool_calls: [
      { function: { arguments: {} } },
      { custom: { input: {} } },
    ],
  });

  const finalizer = await createReferenceFinalizer(references, collectContentViews(turn, state));
  expect(await finalizer.finalizeField(content.original, content.state)).not.toBe(content.original);
  expect(await finalizer.finalizeField(reasoning.original, reasoning.state)).not.toBe(reasoning.original);
  expect(await finalizer.finalizeField(functionArguments.original, functionArguments.state)).not.toBe(functionArguments.original);
  expect(await finalizer.finalizeField(customInput.original, customInput.state)).not.toBe(customInput.original);
  expect(await finalizer.finalizeField(transcript.original, transcript.state)).not.toBe(transcript.original);
});

test('prepares each choice while another choice has partial audio', async () => {
  const source = createIRBuilder(2);
  source.choice(0);
  source.choice(1);
  source.assign(['model'], 'model');
  source.event({ type: 'start', id: 'response' });
  source.initialize(['choices', 1, 'items', 0], { type: 'message', content: [] });
  source.initialize(['choices', 1, 'items', 0, 'content', 0], { type: 'audio', audio: { mime_type: 'audio/wav' } });
  source.initialize(['choices', 1, 'items', 0, 'content', 0, 'audio', 'data'], '');
  source.append(['choices', 1, 'items', 0, 'content', 0, 'audio', 'data'], 'YQ==');
  source.initialize(['choices', 0, 'items', 0], { type: 'message', content: [] });
  source.initialize(['choices', 0, 'items', 0, 'content', 0], { type: 'text', text: '' });
  source.append(['choices', 0, 'items', 0, 'content', 0, 'text'], 'done');
  source.event({ type: 'part_end', choice: 0, item: 0, part: 0 });
  source.event({ type: 'item_end', choice: 0, item: 0 });
  source.event({ type: 'choice_end', choice: 0, finish_reason: 'stop' });
  source.initialize(['choices', 1, 'items', 0, 'content', 0, 'audio', 'transcript'], '');
  source.append(['choices', 1, 'items', 0, 'content', 0, 'audio', 'transcript'], 'a');
  source.event({ type: 'part_end', choice: 1, item: 0, part: 0 });
  source.event({ type: 'item_end', choice: 1, item: 0 });
  source.event({ type: 'choice_end', choice: 1, finish_reason: 'stop' });
  source.event({ type: 'finish', status: 'completed' });

  const prepared: number[] = [];
  const roundTrip: RoundTripWriter<'openaiChatCompletions'> = {
    builder: createReferenceBuilder(),
    prepareSidecar: async choice => { prepared.push(choice); return `sidecar-${choice}`; },
  };
  const frames: string[] = [];
  for await (const frame of openaiChatCompletionsFromIR((async function* () { yield* source.drain(); })(), {
    roundTrip,
    audioMetadata: choice => ({ id: `audio-${choice}`, expires_at: 10 }),
  })) frames.push(JSON.stringify(frame));

  expect(prepared).toEqual([0, 1]);
  expect(frames.join('')).toContain('sidecar-0');
  expect(frames.join('')).toContain('sidecar-1');
});

test.each([false, true])('resolves delayed transcript provenance at actual projection (audio data: %s)', async hasAudioData => {
  const references = createReferenceBuilder();
  const transcript = createFieldState('text');
  const first = appendField(references, transcript, 'late ');
  const second = appendField(references, transcript, 'text');
  const source = createIRBuilder();
  source.choice(0);
  source.assign(['model'], 'model');
  source.event({ type: 'start', id: 'response' });
  const audio = source.item(0, { type: 'message', content: [] });
  const audioPart = audio.part({ type: 'audio', audio: { transcript: '' } });
  audioPart.append(['audio', 'transcript'], 'late ', first);
  const message = source.item(0, { type: 'message', content: [] });
  const text = message.part({ type: 'text', text: '' });
  text.append('text', 'early ');
  text.end();
  message.end();
  audioPart.append(['audio', 'transcript'], 'text', second);
  if (hasAudioData) {
    audioPart.initialize(['audio', 'data'], '');
    audioPart.append(['audio', 'data'], 'YQ==');
  }
  audioPart.end();
  audio.end();
  source.choice(0).end('stop');
  source.event({ type: 'finish', status: 'completed' });

  let prepared: Parameters<RoundTripWriter<'openaiChatCompletions'>['prepareSidecar']> | undefined;
  const roundTrip: RoundTripWriter<'openaiChatCompletions'> = {
    builder: references,
    prepareSidecar: async (...args) => { prepared = args; return 'sidecar'; },
  };
  for await (const _frame of openaiChatCompletionsFromIR((async function* () { yield* source.drain(); })(), {
    roundTrip, audioMetadata: () => ({ id: 'audio', expires_at: 10 }),
  })) {}
  if (prepared === undefined) throw new Error('ChatCompletions sidecar was not prepared');
  const [, , turn, state] = prepared;
  const finalizer = await createReferenceFinalizer(references, collectContentViews(turn, state));
  expect(turn.content).toBe(hasAudioData ? 'early ' : 'early late text');
  expect(await finalizer.finalizeField('late text', transcript)).toEqual(hasAudioData ? 'late text' : expect.objectContaining({ value: [[0, 6, 15]] }));
  if (hasAudioData) expect(turn.audio).toEqual({ id: 'audio' });
});
