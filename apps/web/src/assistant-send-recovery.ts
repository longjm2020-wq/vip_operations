import type {
  AssistantConversation,
  AssistantMessage,
} from "../../../packages/contracts/src/personal-assistant";

const checkIntervalMs = 3_000;
// Match the server's limit for a reserved conversation turn.
const pendingLimitMs = 180_000;

export function canRecoverAssistantSend(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const { status, code } = cause as Error & { status?: number; code?: string };
  return (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === "NETWORK_ERROR" ||
    code === "REQUEST_TIMEOUT" ||
    code === "INVALID_RESPONSE"
  );
}

export async function recoverAssistantSend(input: {
  requestId: string;
  submittedAt: number;
  read: () => Promise<AssistantConversation | undefined>;
  isCurrent: () => boolean;
}): Promise<
  | {
      conversation: AssistantConversation;
      reply?: AssistantMessage;
    }
  | undefined
> {
  const deadline = input.submittedAt + pendingLimitMs;
  while (input.isCurrent()) {
    const conversation = await input.read();
    if (!input.isCurrent()) return;
    if (conversation) {
      const index = conversation.messages.findIndex(
        (message) => message.role === "user" && message.id === input.requestId,
      );
      if (index < 0) return;
      const reply = conversation.messages[index + 1];
      if (reply?.role === "assistant" && !reply.source)
        return { conversation, reply };
      if (index !== conversation.messages.length - 1) return;
      if (conversation.state === "FAILED") return { conversation };
      if (conversation.state !== "PENDING") return;
    }
    if (Date.now() >= deadline) return;

    await new Promise<void>((resolve) => setTimeout(resolve, checkIntervalMs));
  }
}
