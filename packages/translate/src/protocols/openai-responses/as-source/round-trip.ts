
import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, replayMaterialsByType, verifyRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripAssistantTurnInspection, RoundTripConversationTurn } from '../../../round-trip/replay.ts';
import { assistantItemTypeNames } from '../common/assistant-items.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesInputContent, OpenAIResponsesOutputContentBlock, OpenAIResponsesOutputItemEx, OpenAIResponsesOutputReasoning  } from '@floway-dev/protocols/openai-responses';

export const OPENAI_RESPONSES_REPLAY_CHECK_VERSION = 1;

export type OpenAIResponsesAssistantTurnItem = CanonicalOpenAIResponsesInputItem | OpenAIResponsesOutputItemEx;
export type OpenAIResponsesAssistantTurn = OpenAIResponsesAssistantTurnItem[];
export type OpenAIResponsesConversationTurn = RoundTripConversationTurn<'assistant' | 'bare', CanonicalOpenAIResponsesInputItem>;

export type OpenAIResponsesSidecarCarrier = OpenAIResponsesOutputReasoning & { summary: []; encrypted_content: string };

type TypedReplayMaterial = IRJSONObject & { type: string };

const assistantItemTypes = new Set<string>(assistantItemTypeNames);

export const isOpenAIResponsesEncryptedReasoning = (item: OpenAIResponsesAssistantTurnItem): item is Extract<OpenAIResponsesAssistantTurnItem, { type: 'reasoning' }> & { encrypted_content: string } =>
  item.type === 'reasoning' && typeof item.encrypted_content === 'string';

const isResponsesAssistantItem = (item: CanonicalOpenAIResponsesInputItem): boolean => item.type === 'message'
  ? item.role === 'assistant'
  : assistantItemTypes.has(item.type);

const responseMessagePartMaterial = (part: OpenAIResponsesInputContent | OpenAIResponsesOutputContentBlock): TypedReplayMaterial => {
  if (part.type === 'input_text' || part.type === 'output_text') return { type: part.type, text: part.text };
  if (part.type === 'refusal') return { type: part.type, refusal: part.refusal };
  return { type: part.type };
};

const replayItemStatus = (item: OpenAIResponsesAssistantTurnItem): { status?: string | null } =>
  'status' in item && item.status !== undefined ? { status: item.status } : {};

const replayItemMaterial = (item: OpenAIResponsesAssistantTurnItem): TypedReplayMaterial => {
  if (item.type === 'reasoning') return {
    type: item.type,
    ...replayItemStatus(item),
    summary: item.summary.map(part => ({ type: part.type, text: part.text })),
    content: item.content?.map(part => ({ type: part.type, text: part.text })) ?? [],
  };
  if (item.type === 'message') return {
    type: item.type,
    ...replayItemStatus(item),
    content: replayMaterialsByType(typeof item.content === 'string'
      ? [{ type: 'output_text', text: item.content }]
      : item.content.map(responseMessagePartMaterial)),
  };
  if (item.type === 'function_call') return {
    type: item.type,
    ...replayItemStatus(item),
    call_id: item.call_id,
    name: item.name,
    ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
    arguments: item.arguments,
  };
  if (item.type === 'custom_tool_call') return {
    type: item.type,
    ...replayItemStatus(item),
    call_id: item.call_id,
    name: item.name,
    ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
    input: item.input,
  };
  if (item.type === 'image_generation_call') return item.result === undefined
    ? { type: item.type, ...replayItemStatus(item) }
    : { type: item.type, ...replayItemStatus(item), result: item.result };
  return { type: item.type, ...replayItemStatus(item) };
};

const responsesReplayCheckMaterialV1 = (turn: OpenAIResponsesAssistantTurn): IRJSONValue => replayMaterialsByType(turn.map(replayItemMaterial));

const responseSidecars = (turn: OpenAIResponsesAssistantTurn): string[] => turn.flatMap(item => isOpenAIResponsesEncryptedReasoning(item) ? [item.encrypted_content] : []);

export const partitionOpenAIResponsesTurns = (input: readonly CanonicalOpenAIResponsesInputItem[]): OpenAIResponsesConversationTurn[] => {
  const turns: OpenAIResponsesConversationTurn[] = [];
  for (const item of input) {
    const role = isResponsesAssistantItem(item) ? 'assistant' : 'bare';
    const previous = turns.at(-1);
    if (previous?.role === role) previous.items.push(item);
    else turns.push({ role, items: [item] });
  }
  return turns;
};

export const inspectOpenAIResponsesAssistantTurn = (turn: OpenAIResponsesAssistantTurn): RoundTripAssistantTurnInspection => {
  return {
    sidecars: responseSidecars(turn),
    candidates: [],
  };
};

export const computeOpenAIResponsesReplayCheck = (turn: OpenAIResponsesAssistantTurn): Promise<RoundTripReplayCheck> =>
  computeRoundTripReplayCheck(OPENAI_RESPONSES_REPLAY_CHECK_VERSION, responsesReplayCheckMaterialV1(turn));

export const verifyOpenAIResponsesReplayCheck = (
  turn: OpenAIResponsesAssistantTurn,
  replayCheck: RoundTripReplayCheck,
): Promise<boolean> => {
  switch (replayCheck.version) {
  case 1: return verifyRoundTripReplayCheck(responsesReplayCheckMaterialV1(turn), replayCheck);
  default: return Promise.resolve(false);
  }
};

export const createOpenAIResponsesSidecarCarrier = (id: string, data: string): OpenAIResponsesSidecarCarrier => ({
  type: 'reasoning',
  id,
  summary: [],
  encrypted_content: data,
});
