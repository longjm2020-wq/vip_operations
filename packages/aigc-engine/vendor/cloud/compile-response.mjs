// Keep only final assistant text and operational metadata. Never persist model
// reasoning, echoed inputs, image data, credentials, or the whole response body.
export function responseOutputText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  if (Array.isArray(response?.output)) {
    return response.output.flatMap(item => item?.type === "message" && (!item.role || item.role === "assistant")
      ? (item.content || []) : item?.type === "output_text" ? [item] : [])
      .filter(item => item?.type === "output_text" && typeof item.text === "string")
      .map(item => item.text).join("\n");
  }
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(item => ["text", "output_text"].includes(item?.type) && typeof item.text === "string").map(item => item.text).join("\n") : "";
}

const label = value => typeof value === "string" ? value.slice(0, 180) : undefined;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const terminalStatuses = new Set(["completed", "incomplete", "failed", "cancelled"]);

export function compileReceipt(response, maxOutputTokens) {
  const outputText = responseOutputText(response);
  const finish = response?.choices?.[0]?.finish_reason;
  const status = response?.status || (finish === "length" ? "incomplete" : outputText ? "completed" : "unknown");
  return {
    id: label(response?.id), model: label(response?.model), status: label(status),
    reason: label(response?.incomplete_details?.reason || response?.error?.code || (finish === "length" ? "max_output_tokens" : finish)),
    receivedAt: new Date().toISOString(), maxOutputTokens: count(response?.max_output_tokens) ?? count(maxOutputTokens),
    inputTokens: count(response?.usage?.input_tokens ?? response?.usage?.prompt_tokens),
    outputTokens: count(response?.usage?.output_tokens ?? response?.usage?.completion_tokens),
    reasoningTokens: count(response?.usage?.output_tokens_details?.reasoning_tokens ?? response?.usage?.completion_tokens_details?.reasoning_tokens),
    outputText: outputText.slice(0, 512_000), outputOversized: outputText.length > 512_000,
  };
}

export function isTerminalCompileReceipt(receipt) { return terminalStatuses.has(receipt?.status); }

export function compileReceiptSummary(receipt) {
  if (!receipt) return undefined;
  const { id, model, status, reason, receivedAt, inputTokens, outputTokens, reasoningTokens, maxOutputTokens } = receipt;
  return { id, model, status, reason, receivedAt, inputTokens, outputTokens, reasoningTokens, maxOutputTokens };
}

export function compileReceiptIssue(receipt) {
  if (receipt.status === "incomplete" && receipt.reason === "max_output_tokens") return `编译输出达到 ${receipt.maxOutputTokens || receipt.outputTokens || "配置的"} token 上限被截断，未取得完整 B/C JSON`;
  if (receipt.status !== "completed") return `编译供应商已结束请求，状态 ${receipt.status}${receipt.reason ? `（${receipt.reason}）` : ""}，未交付完整 B/C JSON`;
  if (receipt.outputOversized) return "编译回包超出安全大小，未保存为有效 B/C";
  if (!receipt.outputText?.trim()) return "编译请求已结束，但没有返回 B/C JSON 正文";
  return undefined;
}

export function compileRequestOptions(provider) {
  // Scope this to the verified GPT-5 contract; do not send incompatible options
  // to other configured models. Keep the existing cost cap, reserve more of it
  // for the actual JSON instead of verbose reasoning and duplicated prose.
  const model = provider.model?.replace(/^openai\//, "");
  return ["openrouter", "openai"].includes(provider.id) && /^gpt-5(?:-2025-08-07)?$/.test(model || "")
    ? { reasoning: { effort: "low" }, text: { format: { type: "json_object" }, verbosity: "low" } } : {};
}
