
import type { IRJSONObject } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, verifyRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripAssistantTurnInspection, RoundTripConversationTurn } from '../../../round-trip/replay.ts';
import type { ReplayCandidate } from '../../../round-trip/thin/assistant-turn.ts';
import { requireJSONObject } from '../../../shared/json/object.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

export const GEMINI_GENERATE_CONTENT_REPLAY_CHECK_VERSION = 1;

export type GeminiGenerateContentAssistantTurn = GeminiGenerateContentContent[];
export type GeminiGenerateContentConversationTurn = RoundTripConversationTurn<'assistant' | 'bare', GeminiGenerateContentContent>;
export type GeminiGenerateContentSidecarCarrier = GeminiGenerateContentPart & { thoughtSignature: string };

const partSidecarValues = (part: GeminiGenerateContentPart): string[] => typeof part.thoughtSignature === 'string' ? [part.thoughtSignature] : [];

export const hasGeminiGenerateContentThoughtSignature = (content: GeminiGenerateContentContent): boolean =>
  content.parts?.some(part => part.thoughtSignature !== undefined) ?? false;

const geminiReplayCheckMaterialV1 = (turn: GeminiGenerateContentAssistantTurn): IRJSONObject => {
  const text: string[] = [];
  const inlineData: { mimeType: string; data: string; audioTranscription?: string }[] = [];
  const functionCall: { id?: string; name: string; args?: IRJSONObject }[] = [];

  for (const content of turn) for (const part of content.parts ?? []) {
    if (part.thought !== true && part.text !== undefined) text.push(part.text);
    if (part.inlineData !== undefined) inlineData.push({
      mimeType: part.inlineData.mimeType,
      data: part.inlineData.data,
      ...(part.audioTranscription === undefined ? {} : { audioTranscription: part.audioTranscription.text }),
    });
    if (part.functionCall !== undefined) functionCall.push({
      ...(part.functionCall.id === undefined ? {} : { id: part.functionCall.id }),
      name: part.functionCall.name,
      ...(part.functionCall.args === undefined ? {} : { args: requireJSONObject(part.functionCall.args) }),
    });
  }

  return { text, inlineData, functionCall };
};

const collectPartCandidates = (candidates: ReplayCandidate[], part: GeminiGenerateContentPart): void => {
  if (part.thought !== true && typeof part.text === 'string') candidates.push(part.text);
  if (part.inlineData !== undefined) candidates.push(part.inlineData.data);
  if (part.audioTranscription !== undefined) candidates.push(part.audioTranscription.text);
  if (part.functionCall?.args !== undefined) candidates.push(requireJSONObject(part.functionCall.args));
};

export const partitionGeminiGenerateContentTurns = (contents: readonly GeminiGenerateContentContent[]): GeminiGenerateContentConversationTurn[] => {
  const turns: GeminiGenerateContentConversationTurn[] = [];
  for (const content of contents) {
    const role = content.role === 'model' ? 'assistant' : 'bare';
    const previous = turns.at(-1);
    if (previous?.role === role) previous.items.push(content);
    else turns.push({ role, items: [content] });
  }
  return turns;
};

export const inspectGeminiGenerateContentAssistantTurn = (turn: GeminiGenerateContentAssistantTurn): RoundTripAssistantTurnInspection => {
  const candidates: ReplayCandidate[] = [];
  const sidecars = turn.flatMap(content => content.parts === undefined ? [] : content.parts.flatMap(partSidecarValues));
  for (const content of turn) if (content.parts !== undefined) for (const part of content.parts) collectPartCandidates(candidates, part);
  return {
    sidecars,
    candidates,
  };
};

export const computeGeminiGenerateContentReplayCheck = (turn: GeminiGenerateContentAssistantTurn): Promise<RoundTripReplayCheck> =>
  computeRoundTripReplayCheck(GEMINI_GENERATE_CONTENT_REPLAY_CHECK_VERSION, geminiReplayCheckMaterialV1(turn));

export const verifyGeminiGenerateContentReplayCheck = (
  turn: GeminiGenerateContentAssistantTurn,
  replayCheck: RoundTripReplayCheck,
): Promise<boolean> => {
  switch (replayCheck.version) {
  case 1: return verifyRoundTripReplayCheck(geminiReplayCheckMaterialV1(turn), replayCheck);
  default: return Promise.resolve(false);
  }
};

// Gemini returns model-side thought signatures as Part metadata.
// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
export const createGeminiGenerateContentSidecarCarrier = (data: string): GeminiGenerateContentSidecarCarrier => ({ thoughtSignature: data });
