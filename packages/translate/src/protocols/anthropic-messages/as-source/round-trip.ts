
import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, replayMaterialsByType, verifyRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripAssistantTurnInspection, RoundTripConversationTurn } from '../../../round-trip/replay.ts';
import { requireJSONObject } from '../../../shared/json/object.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesAssistantMessage, AnthropicMessagesRedactedThinkingBlock, AnthropicMessagesMessage } from '@floway-dev/protocols/anthropic-messages';

export const ANTHROPIC_MESSAGES_REPLAY_CHECK_VERSION = 1;

export type AnthropicMessagesAssistantTurn = (AnthropicMessagesAssistantMessage | { role: 'assistant'; content: AnthropicMessagesAssistantContentBlock[] })[];
export type AnthropicMessagesConversationTurn =
  | RoundTripConversationTurn<'assistant', AnthropicMessagesAssistantMessage>
  | RoundTripConversationTurn<'user' | 'system', Exclude<AnthropicMessagesMessage, { role: 'assistant' }>>;

type TypedReplayMaterial = IRJSONObject & { type: string };

const redactedThinkingSidecars = (turn: AnthropicMessagesAssistantTurn): string[] => turn.flatMap(message => Array.isArray(message.content)
  ? message.content.flatMap(block => block.type === 'redacted_thinking' ? [block.data] : [])
  : []);

const messagesReplayCheckMaterialV1 = (turn: AnthropicMessagesAssistantTurn): IRJSONValue => {
  const blocks: TypedReplayMaterial[] = [];
  for (const message of turn) {
    if (typeof message.content === 'string') {
      blocks.push({ type: 'text', text: message.content, citations: [] });
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'text') blocks.push({
        type: block.type,
        text: block.text,
        citations: block.citations?.map(citation => citation.cited_text) ?? [],
      });
      else if (block.type === 'thinking') blocks.push({ type: block.type, thinking: block.thinking });
      else if (block.type === 'tool_use') blocks.push({ type: block.type, id: block.id, name: block.name, input: requireJSONObject(block.input) });
      else blocks.push({ type: block.type });
    }
  }
  return replayMaterialsByType(blocks);
};

export const partitionAnthropicMessagesTurns = (messages: readonly AnthropicMessagesMessage[]): AnthropicMessagesConversationTurn[] => {
  const turns: AnthropicMessagesConversationTurn[] = [];
  for (const message of messages) {
    const previous = turns.at(-1);
    if (message.role === 'assistant') {
      if (previous?.role === 'assistant') previous.items.push(message);
      else turns.push({ role: 'assistant', items: [message] });
    } else if (previous?.role === message.role) previous.items.push(message);
    else turns.push({ role: message.role, items: [message] });
  }
  return turns;
};

export const inspectAnthropicMessagesAssistantTurn = (turn: AnthropicMessagesAssistantTurn): RoundTripAssistantTurnInspection => {
  return {
    sidecars: redactedThinkingSidecars(turn),
  };
};

export const computeAnthropicMessagesReplayCheck = (turn: AnthropicMessagesAssistantTurn): Promise<RoundTripReplayCheck> =>
  computeRoundTripReplayCheck(ANTHROPIC_MESSAGES_REPLAY_CHECK_VERSION, messagesReplayCheckMaterialV1(turn));

export const verifyAnthropicMessagesReplayCheck = (
  turn: AnthropicMessagesAssistantTurn,
  replayCheck: RoundTripReplayCheck,
): Promise<boolean> => {
  switch (replayCheck.version) {
  case 1: return verifyRoundTripReplayCheck(messagesReplayCheckMaterialV1(turn), replayCheck);
  default: return Promise.resolve(false);
  }
};

export const createAnthropicMessagesSidecarCarrier = (data: string): AnthropicMessagesRedactedThinkingBlock => ({ type: 'redacted_thinking', data });
