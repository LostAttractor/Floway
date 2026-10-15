import { Tag } from 'cbor-x';
import { describe, expect, it } from 'vitest';

import { createAssistantTurnSidecarCodec, hasRoundTripTarget, type RoundTripSidecarPayload } from '../../../src/round-trip/codec.ts';
import { computeRoundTripReplayCheck } from '../../../src/round-trip/replay-check.ts';
import { THIN_TAGS, type ReferencePart, type TextReference } from '../../../src/round-trip/thin/assistant-turn.ts';
import { hydrateAssistantTurn } from '../../../src/round-trip/thin/hydrate.ts';
import { appendContent, appendField, collectContentViews, createContentState, createFieldState, createReferenceBuilder, finalizeAssistantTurnReferences } from '../../../src/round-trip/thin/reference-builder.ts';
import { assert } from '@floway-dev/test-utils';

const encodeAndDecode = async (payload: Omit<RoundTripSidecarPayload<'openaiChatCompletions'>, 'target' | 'replayCheck'>) => {
  const codec = createAssistantTurnSidecarCodec('optional-references-test');
  const encoded = await codec.encode('openaiResponses', {
    target: 'openaiChatCompletions',
    ...payload,
    replayCheck: await computeRoundTripReplayCheck(1, { text: '[hello]' }),
  });
  const decoded = await codec.decode('openaiResponses', encoded);
  assert(decoded !== undefined && hasRoundTripTarget(decoded, 'openaiChatCompletions'));
  return decoded;
};

describe('optional reference dictionary', () => {
  it('round-trips a literal assistant turn without a dictionary member', async () => {
    const original = { role: 'assistant' as const, content: 'hello' };
    const finalized = await finalizeAssistantTurnReferences<'openaiChatCompletions'>(original, {}, createReferenceBuilder(), new Map());
    expect(Object.hasOwn(finalized, 'referencedContents')).toBe(false);

    const decoded = await encodeAndDecode(finalized);
    expect(Object.hasOwn(decoded, 'referencedContents')).toBe(false);
    expect(await hydrateAssistantTurn('openaiChatCompletions', [], decoded.assistantTurn, decoded.referencedContents)).toEqual({ ok: true, turn: original });
  });

  it.each(['unresolved atom', 'changed original field'])('omits the dictionary when valid A views produce no reference: %s', async reason => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const first = appendField(builder, field, 'hel');
    const second = appendField(builder, field, 'lo');
    const content = createContentState(builder, 'text');
    appendContent(builder, content, '[');
    appendContent(builder, content, 'hel', first);
    appendContent(builder, content, 'lo', reason === 'unresolved atom' ? undefined : second);
    appendContent(builder, content, ']');
    const views = collectContentViews('[hello]', content);
    expect(views.size).toBe(1);
    const original = { role: 'assistant' as const, content: reason === 'changed original field' ? 'changed' : 'hello' };
    const finalized = await finalizeAssistantTurnReferences<'openaiChatCompletions'>(original, { content: field }, builder, views);
    expect(finalized.assistantTurn).toEqual(original);
    expect(Object.hasOwn(finalized, 'referencedContents')).toBe(false);

    const decoded = await encodeAndDecode(finalized);
    expect(Object.hasOwn(decoded, 'referencedContents')).toBe(false);
    expect(await hydrateAssistantTurn('openaiChatCompletions', ['[hello]'], decoded.assistantTurn, decoded.referencedContents)).toEqual({ ok: true, turn: original });
  });

  it('carries the dictionary when SSE atoms produce a reference and restores the complete original turn', async () => {
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const first = appendField(builder, field, 'hel');
    const second = appendField(builder, field, 'lo');
    const content = createContentState(builder, 'text');
    appendContent(builder, content, '[');
    appendContent(builder, content, 'hel', first);
    appendContent(builder, content, 'lo', second);
    appendContent(builder, content, ']');
    const original = { role: 'assistant' as const, content: 'hello', reasoning_opaque: 'native B state' };
    const finalized = await finalizeAssistantTurnReferences<'openaiChatCompletions'>(original, { content: field }, builder, collectContentViews('[hello]', content));
    expect(finalized.assistantTurn.content).toBeInstanceOf(Tag);
    expect(Object.hasOwn(finalized, 'referencedContents')).toBe(true);

    const decoded = await encodeAndDecode(finalized);
    expect(Object.hasOwn(decoded, 'referencedContents')).toBe(true);
    expect(await hydrateAssistantTurn('openaiChatCompletions', ['[hello]'], decoded.assistantTurn, decoded.referencedContents)).toEqual({ ok: true, turn: original });
  });

  it('reduces the signed carrier size while restoring the same complete turn', async () => {
    const text = 'The client already carries this assistant text. '.repeat(128);
    const original = { role: 'assistant' as const, content: text };
    const builder = createReferenceBuilder();
    const field = createFieldState('text');
    const partId = appendField(builder, field, text);
    const content = createContentState(builder, 'text');
    appendContent(builder, content, text, partId);
    const finalized = await finalizeAssistantTurnReferences<'openaiChatCompletions'>(original, { content: field }, builder, collectContentViews(text, content));
    const codec = createAssistantTurnSidecarCodec('carrier-size-test');
    const replayCheck = await computeRoundTripReplayCheck(1, { text });
    const full = await codec.encode('openaiResponses', { target: 'openaiChatCompletions', assistantTurn: original, replayCheck });
    const thin = await codec.encode('openaiResponses', { target: 'openaiChatCompletions', ...finalized, replayCheck });
    expect(thin.length).toBeLessThan(full.length);

    const decoded = await codec.decode('openaiResponses', thin);
    assert(decoded !== undefined && hasRoundTripTarget(decoded, 'openaiChatCompletions'));
    expect(await hydrateAssistantTurn('openaiChatCompletions', [text], decoded.assistantTurn, decoded.referencedContents)).toEqual({ ok: true, turn: original });
  });

  it.each<{ parts: ReferencePart[] }>([{ parts: [] }, { parts: [0] }])('rejects a signed reference without its dictionary: $parts', async ({ parts }) => {
    const decoded = await encodeAndDecode({
      assistantTurn: { role: 'assistant', content: new Tag(parts, THIN_TAGS.text) as TextReference },
    });

    await expect(hydrateAssistantTurn('openaiChatCompletions', ['hello'], decoded.assistantTurn, decoded.referencedContents)).rejects.toThrow('Thin reference requires referenced contents');
  });
});
