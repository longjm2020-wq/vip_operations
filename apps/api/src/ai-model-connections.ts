import { db, rows } from "../../../packages/database/src/index.js";
import { encryptionReady } from "./modules/analytics/secrets.js";

// Only these features use the shared OpenRouter credential. Audio and AIGC
// receipts can use independent keys and must not verify this connection.
const sharedFeatures = [
  "assistant_chat",
  "assistant_search",
  "assistant_website",
  "assistant_desktop",
  "assistant_team",
  "deerflow_team",
  "compass_analysis",
  "product_titles",
  "product_standards",
];

/** Read current server receipts; listing models never sends a paid probe. */
export async function connectedModelRefs(
  models: { id: string; actual: string; provider?: "bailian" }[],
): Promise<Set<string>> {
  if (!models.length || !encryptionReady()) return new Set();
  const latest = await rows(
    db,
    `SELECT DISTINCT ON(u.model) u.model,u.status,u.response_model
    FROM public.ai_model_usage u
    JOIN public.compass_ai_settings s ON s.id=1
    WHERE s.enabled AND s.api_key_encrypted IS NOT NULL AND s.verified_at IS NOT NULL
      AND u.source='openrouter.ai' AND u.feature_id=ANY($1::text[])
      AND u.model=ANY($2::text[]) AND u.started_at>=s.updated_at
      AND u.status IN ('success','failed','responded')
    ORDER BY u.model,u.started_at DESC,u.id DESC`,
    sharedFeatures,
    [
      ...new Set(
        models
          .filter((model) => model.provider !== "bailian")
          .map((model) => model.actual),
      ),
    ],
  );
  const connected = new Set(
    latest
      .filter(
        (receipt) => receipt.status === "success" && receipt.response_model,
      )
      .map((receipt) => receipt.model),
  );
  const result = new Set(
    models
      .filter(
        (model) => model.provider !== "bailian" && connected.has(model.actual),
      )
      .map((model) => model.id),
  );
  const bailianModels = models.filter((model) => model.provider === "bailian");
  if (bailianModels.length) {
    const receipts = await rows(
      db,
      `SELECT DISTINCT ON(u.model) u.model,u.status,u.response_model
      FROM public.ai_model_usage u JOIN public.bailian_chat_settings s ON s.id=1
      WHERE s.enabled AND s.api_key_encrypted IS NOT NULL AND s.verified_at IS NOT NULL
        AND u.source=s.workspace_id||'.cn-beijing.maas.aliyuncs.com'
        AND u.feature_id='assistant_chat' AND u.model=ANY($1::text[]) AND u.started_at>=s.updated_at
        AND u.status IN ('success','failed','responded') ORDER BY u.model,u.started_at DESC,u.id DESC`,
      bailianModels.map((model) => model.actual),
    );
    for (const model of bailianModels)
      if (
        receipts.some(
          (receipt) =>
            receipt.model === model.actual &&
            receipt.status === "success" &&
            receipt.response_model === model.actual,
        )
      )
        result.add(model.id);
  }
  return result;
}
