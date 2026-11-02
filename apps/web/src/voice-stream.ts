import { csrf, queryClient } from "./api";
import type { VoiceEvent } from "../../../packages/contracts/src/assistant-voice";

export async function requestVoiceStream(
  kind: "turn" | "speech",
  body: { id: string; [key: string]: unknown },
  signal: AbortSignal,
  onEvent: (event: VoiceEvent) => void,
) {
  const response = await fetch(`/api/v1/my-workspace/assistant/voice/${kind}`, {
    method: "POST",
    credentials: "include",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      "Idempotency-Key": body.id,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 401) queryClient.setQueryData(["me"], null);
    const value = await response.json();
    throw Error(value.error?.message || "语音请求失败");
  }
  if (!response.body) throw Error("语音服务没有返回数据");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    completed = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 2000000) throw Error("语音数据异常");
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        signal.throwIfAborted();
        const event = JSON.parse(line) as VoiceEvent;
        if (event.type === "error") throw Error(event.message);
        if (event.type === "done" || event.type === "retry-listening")
          completed = true;
        onEvent(event);
      }
    }
    if (!completed || pending.trim())
      throw Error("语音回复未完整接收，请查看文字对话");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
