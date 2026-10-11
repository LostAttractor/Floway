import type { IRSSEOutputOptions } from './sse-output-options.ts';
import type { IREvent } from './stream.ts';

export const irOutputMetadata = (event: Extract<IREvent, { type: 'start' }>, options: IRSSEOutputOptions) => ({
  id: options.id ?? event.id,
  model: event.model,
  created: event.created ?? options.created ?? Math.floor(Date.now() / 1000),
});
