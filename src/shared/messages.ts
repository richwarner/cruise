export const INTERNAL_TURN_MESSAGE_ID_PREFIX = "internal-agent-turn:";

export function isInternalTurnMessageId(messageId: string) {
  return messageId.startsWith(INTERNAL_TURN_MESSAGE_ID_PREFIX);
}
