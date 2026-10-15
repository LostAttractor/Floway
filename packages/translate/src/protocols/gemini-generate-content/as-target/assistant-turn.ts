import type { ThinState, ThinStateLeaves, ThinValue, TextRule, JSONRule } from '../../../round-trip/thin/assistant-turn.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

type GeminiPartRule = {
  text: TextRule;
  inlineData: { data: TextRule };
  audioTranscription: { text: TextRule };
  functionCall: { args: JSONRule };
};

type GeminiThinPart<Reference> = ThinValue<GeminiGenerateContentPart, GeminiPartRule, Reference>;
type GeminiAssistantContent = Omit<GeminiGenerateContentContent, 'role' | 'parts'> & {
  role: 'model';
  parts?: GeminiGenerateContentPart[];
};

export type GeminiGenerateContentThinAssistantTurn<Reference> = Array<Omit<GeminiAssistantContent, 'parts'> & { parts?: GeminiThinPart<Reference>[] }>;
export type GeminiGenerateContentInputAssistantTurn = GeminiAssistantContent[];
export type GeminiGenerateContentAssistantState<States extends ThinStateLeaves> = Array<ThinState<GeminiAssistantContent, { parts: [GeminiPartRule] }, States> | undefined>;
