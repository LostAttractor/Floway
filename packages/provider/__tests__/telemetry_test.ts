import { expect, test } from 'vitest';

import { anthropicMessagesServiceTier } from '@floway-dev/protocols/anthropic-messages';

test('Messages request intent preserves open speed and service tier strings', () => {
  expect(anthropicMessagesServiceTier({ speed: 'vendor-fast', service_tier: 'auto' })).toBe('vendor-fast');
  expect(anthropicMessagesServiceTier({ service_tier: 'standard_only' })).toBe('standard_only');
  expect(anthropicMessagesServiceTier({ speed: null, service_tier: 'auto' })).toBeNull();
});
