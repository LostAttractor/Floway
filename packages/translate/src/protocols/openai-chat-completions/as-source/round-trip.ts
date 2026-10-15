
import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, verifyRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripAssistantTurnInspection } from '../../../round-trip/replay.ts';
import type { ReplayCandidate } from '../../../round-trip/thin/assistant-turn.ts';
import type { OpenAIChatCompletionsAssistantExtensions, OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsAssistantOutputMessage, OpenAIChatCompletionsMessage, OpenAIChatCompletionsToolCallEx } from '@floway-dev/protocols/openai-chat-completions';

export const OPENAI_CHAT_COMPLETIONS_REPLAY_CHECK_VERSION = 1;

export type OpenAIChatCompletionsConversationMessage = OpenAIChatCompletionsMessage | OpenAIChatCompletionsAssistantMessageEx;
export type OpenAIChatCompletionsAssistantTurn = (OpenAIChatCompletionsAssistantMessage | OpenAIChatCompletionsAssistantOutputMessage)
  & Pick<OpenAIChatCompletionsAssistantExtensions, 'reasoning' | 'reasoning_text' | 'reasoning_content' | 'reasoning_details'>;
export type OpenAIChatCompletionsConversationTurn =
  | { role: 'assistant'; items: [OpenAIChatCompletionsAssistantTurn] }
  | { role: 'bare'; items: [Exclude<OpenAIChatCompletionsMessage, { role: 'assistant' }>] };

export type OpenAIChatCompletionsReasoningDetailsCarrier =
  | { type: 'reasoning.summary'; summary: string; format: 'unknown'; index: 0 }
  | { type: 'reasoning.encrypted'; data: string; format: 'unknown'; index: 1 };

const reasoningFields = ['reasoning', 'reasoning_text', 'reasoning_content'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const reasoningDetails = (turn: OpenAIChatCompletionsAssistantTurn): unknown[] => Array.isArray(turn.reasoning_details) ? turn.reasoning_details : [];

const readReasoningDetailsSummary = (turn: OpenAIChatCompletionsAssistantTurn): string[] => reasoningDetails(turn).flatMap(value => {
  const item = isRecord(value) ? value : undefined;
  return item?.type === 'reasoning.summary' && typeof item.summary === 'string' ? [item.summary] : [];
});

const reasoningDetailsMaterial = (turn: OpenAIChatCompletionsAssistantTurn): IRJSONObject[] => {
  const materials: IRJSONObject[] = [];
  for (const value of reasoningDetails(turn)) {
    const item = isRecord(value) ? value : undefined;
    if (item?.type === 'reasoning.summary' && typeof item.summary === 'string') materials.push({ type: item.type, summary: item.summary });
    else if (typeof item?.type === 'string') materials.push({ type: item.type });
    else materials.push({});
  }
  return materials;
};

const reasoningDetailSidecars = (turn: OpenAIChatCompletionsAssistantTurn): string[] => reasoningDetails(turn).flatMap(value => {
  const item = isRecord(value) ? value : undefined;
  return item?.type === 'reasoning.encrypted' && typeof item.data === 'string' ? [item.data] : [];
});

const messageContentMaterial = (turn: OpenAIChatCompletionsAssistantTurn): IRJSONValue | undefined => {
  if (typeof turn.content === 'string' || turn.content === null || turn.content === undefined) return turn.content;
  const parts: IRJSONObject[] = [];
  for (const part of turn.content) parts.push(part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'refusal', refusal: part.refusal });
  return parts;
};

const toolCallMaterial = (call: OpenAIChatCompletionsToolCallEx): IRJSONObject => call.type === 'function'
  ? { type: 'function', id: call.id, name: call.function.name, arguments: call.function.arguments }
  : { type: 'custom', id: call.id, name: call.custom.name, input: call.custom.input };

const reasoningTextMaterial = (turn: OpenAIChatCompletionsAssistantTurn): IRJSONObject[] => {
  const materials: IRJSONObject[] = [];
  for (const field of reasoningFields) {
    if (!Object.hasOwn(turn, field)) continue;
    const value = turn[field];
    materials.push(value === undefined ? { field } : { field, value });
  }
  return materials;
};

export const hasOpenAIChatCompletionsReasoning = (turn: OpenAIChatCompletionsAssistantTurn): boolean =>
  reasoningFields.some(field => turn[field] != null) || reasoningDetails(turn).length > 0;

const chatReplayCheckMaterialV1 = (turn: OpenAIChatCompletionsAssistantTurn): IRJSONObject => ({
  ...(Object.hasOwn(turn, 'content') && turn.content !== undefined ? { content: messageContentMaterial(turn) } : {}),
  ...(Object.hasOwn(turn, 'refusal') && turn.refusal !== undefined ? { refusal: turn.refusal } : {}),
  ...(turn.function_call != null
    ? { function_call: { name: turn.function_call.name, arguments: turn.function_call.arguments } }
    : turn.function_call === null ? { function_call: null } : {}),
  ...(turn.tool_calls !== undefined ? { tool_calls: turn.tool_calls.map(toolCallMaterial) } : {}),
  reasoningText: reasoningTextMaterial(turn),
  reasoningDetails: reasoningDetailsMaterial(turn),
});

const collectString = (candidates: ReplayCandidate[], value: string | null | undefined): void => {
  if (typeof value === 'string') candidates.push(value);
};

export const partitionOpenAIChatCompletionsTurns = (messages: readonly OpenAIChatCompletionsConversationMessage[]): OpenAIChatCompletionsConversationTurn[] => messages.map(message => message.role === 'assistant'
  ? { role: 'assistant', items: [message] }
  : { role: 'bare', items: [message] });

export const inspectOpenAIChatCompletionsAssistantTurn = (turn: OpenAIChatCompletionsAssistantTurn): RoundTripAssistantTurnInspection => {
  const candidates: ReplayCandidate[] = [];
  if (typeof turn.content === 'string') collectString(candidates, turn.content);
  else if (Array.isArray(turn.content)) for (const part of turn.content) collectString(candidates, part.type === 'text' ? part.text : part.refusal);
  collectString(candidates, turn.refusal);
  for (const field of reasoningFields) collectString(candidates, turn[field]);
  candidates.push(...readReasoningDetailsSummary(turn));
  if (turn.function_call !== undefined && turn.function_call !== null) collectString(candidates, turn.function_call.arguments);
  for (const call of turn.tool_calls ?? []) collectString(candidates, call.type === 'function' ? call.function.arguments : call.custom.input);
  return {
    sidecars: reasoningDetailSidecars(turn),
    candidates,
  };
};

export const computeOpenAIChatCompletionsReplayCheck = (turn: OpenAIChatCompletionsAssistantTurn): Promise<RoundTripReplayCheck> =>
  computeRoundTripReplayCheck(OPENAI_CHAT_COMPLETIONS_REPLAY_CHECK_VERSION, chatReplayCheckMaterialV1(turn));

export const verifyOpenAIChatCompletionsReplayCheck = (
  turn: OpenAIChatCompletionsAssistantTurn,
  replayCheck: RoundTripReplayCheck,
): Promise<boolean> => {
  switch (replayCheck.version) {
  case 1: return verifyRoundTripReplayCheck(chatReplayCheckMaterialV1(turn), replayCheck);
  default: return Promise.resolve(false);
  }
};

// Our carrier uses indexed OpenRouter reasoning_details, with an optional readable summary.
// https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#reasoning-details-api-shape
export const createOpenAIChatCompletionsSidecarCarrier = (data: string, summary?: string): OpenAIChatCompletionsReasoningDetailsCarrier[] => {
  const carrier: OpenAIChatCompletionsReasoningDetailsCarrier[] = [];
  if (summary !== undefined) carrier.push({ type: 'reasoning.summary', summary, format: 'unknown', index: 0 });
  carrier.push({ type: 'reasoning.encrypted', data, format: 'unknown', index: 1 });
  return carrier;
};
