import { db, one } from "../../../packages/database/src/index.js";
import type { AiFeatureId } from "../../../packages/contracts/src/ai-management.js";

/** Read on each new operation, so workers and API processes share durable defaults. */
export async function featureModelRef(
  feature: AiFeatureId,
): Promise<string | undefined> {
  const value = await one(
    db,
    "SELECT model_ref FROM public.ai_feature_models WHERE feature_id=$1",
    feature,
  );
  return value?.model_ref || undefined;
}
