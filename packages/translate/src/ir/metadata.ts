import type { IROutputOptions } from './projection.ts';
import type { IREvent } from './stream.ts';

export const irOutputMetadata = (event: Extract<IREvent, { type: 'start' }>, options: IROutputOptions) => ({
  id: options.id ?? event.id,
  model: event.model,
  created: event.created ?? options.created ?? Math.floor(Date.now() / 1000),
});
