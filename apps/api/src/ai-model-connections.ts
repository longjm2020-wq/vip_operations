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
  models: { id: string; actual: string }[],
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
    [...new Set(models.map((model) => model.actual))],
  );
  const connected = new Set(
    latest
      .filter(
        (receipt) => receipt.status === "success" && receipt.response_model,
      )
      .map((receipt) => receipt.model),
  );
  return new Set(
    models
      .filter((model) => connected.has(model.actual))
      .map((model) => model.id),
  );
}
