import { createAssistantTurnSidecarCodec } from '../../src/round-trip/codec.ts';

export const createTestSidecarCodec = () => createAssistantTurnSidecarCodec('test-server-secret');
