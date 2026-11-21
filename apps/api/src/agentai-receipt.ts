function boundedReceiptId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function agentAiChatReceiptId(
  bodyId: unknown,
  headers: Headers,
): string | undefined {
  if (boundedReceiptId(bodyId)) return bodyId;
  // Some AgentAI adapters emit only the documented response header.
  const headerId = headers.get("X-Request-Id");
  return boundedReceiptId(headerId) ? headerId : undefined;
}
