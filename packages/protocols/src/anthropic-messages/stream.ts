import type { AnthropicMessagesStreamEventEx } from './index.ts';
import { anthropicMessagesServiceTier } from './service-tier.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame, type SseFrame } from '../common/sse.ts';

export interface ParseAnthropicMessagesStreamOptions {
  signal?: AbortSignal;
  onSseFrame?: (frame: SseFrame) => void;
  onServiceTier?: (tier: string | null | undefined) => void;
}

export const parseAnthropicMessagesStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseAnthropicMessagesStreamOptions = {},
): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> => (async function* () {
  const observed: { speed?: string | null; service_tier?: string | null } = {};
  const rawFrames = (async function* () {
    for await (const frame of parseSSEStream(body, options)) {
      options.onSseFrame?.(frame);
      yield frame;
    }
  })();
  for await (const frame of parseTargetStreamFrames<AnthropicMessagesStreamEventEx>(rawFrames, {
    protocol: 'Anthropic Messages',
    malformedJsonEventName: 'message',
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
      return;
    }
    const event = frame.data;
    const usage = event.type === 'message_start' ? event.message.usage : event.type === 'message_delta' ? event.usage : undefined;
    if (usage !== undefined) {
      if (usage.speed !== undefined) observed.speed = usage.speed;
      if (usage.service_tier !== undefined) observed.service_tier = usage.service_tier;
      options.onServiceTier?.(anthropicMessagesServiceTier(observed));
    }
    yield eventFrame(event);
  }
})();
