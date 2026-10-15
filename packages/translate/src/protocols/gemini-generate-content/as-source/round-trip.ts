
import type { IRJSONObject } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import { requireJSONObject } from '../../../shared/json/object.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

export const GEMINI_GENERATE_CONTENT_REPLAY_CHECK_VERSION = 1;

export type GeminiGenerateContentAssistantTurn = GeminiGenerateContentContent[];
export type GeminiGenerateContentSidecarCarrier = GeminiGenerateContentPart & { thoughtSignature: string };

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

export const computeGeminiGenerateContentReplayCheck = (turn: GeminiGenerateContentAssistantTurn): Promise<RoundTripReplayCheck> =>
  computeRoundTripReplayCheck(GEMINI_GENERATE_CONTENT_REPLAY_CHECK_VERSION, geminiReplayCheckMaterialV1(turn));

// Gemini returns model-side thought signatures as Part metadata.
// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
export const createGeminiGenerateContentSidecarCarrier = (data: string): GeminiGenerateContentSidecarCarrier => ({ thoughtSignature: data });
