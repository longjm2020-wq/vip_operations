import { db, rows } from "../../../packages/database/src/index.js";
import { encryptionReady } from "./modules/analytics/secrets.js";

// Only these features use the shared OpenRouter credential. Audio and AIGC
// receipts can use independent keys and must not verify this connection.
// Historical receipts still attest to the same credential and model version.
const sharedFeatures = [
  "assistant_chat",
  "assistant_intent",
  "director_storyboard",
  "director_reference",
  "assistant_search",
  "assistant_website",
  "assistant_desktop",
  "assistant_browser",
  "assistant_employee",
  "assistant_team",
  "deerflow_team",
  "compass_analysis",
  "product_titles",
  "product_standards",
];

/** Read current server receipts; listing models never sends a paid probe. */
export async function connectedModelRefs(
  models: {
    id: string;
    actual: string;
    provider?: "bailian" | "agentai" | "relay";
    stationId?: string;
  }[],
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
        models.filter((model) => !model.provider).map((model) => model.actual),
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
      .filter((model) => !model.provider && connected.has(model.actual))
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
  const agentaiModels = models.filter((model) => model.provider === "agentai");
  if (agentaiModels.length) {
    const receipts = await rows(
      db,
      `SELECT DISTINCT ON(u.model) u.model,u.status,u.response_model
      FROM public.ai_model_usage u JOIN public.agentai_settings s ON s.id=1
      JOIN public.agentai_model_verifications v ON v.model=u.model AND v.settings_version=s.version
      WHERE s.enabled AND s.api_key_encrypted IS NOT NULL AND s.verified_at IS NOT NULL AND v.chat_verified_at IS NOT NULL
        AND u.source='agentai.token6688.com' AND u.feature_id=ANY($1::text[]) AND u.model=ANY($2::text[]) AND u.started_at>=s.updated_at
        AND u.status IN ('success','failed','responded') ORDER BY u.model,u.started_at DESC,u.id DESC`,
      ["assistant_chat", "assistant_team", "assistant_employee", "mastra_team"],
      agentaiModels.map((m) => m.actual),
    );
    for (const model of agentaiModels)
      if (
        receipts.some(
          (r) =>
            r.model === model.actual &&
            r.status === "success" &&
            r.response_model === model.actual,
        )
      )
        result.add(model.id);
  }
  const relayModels = models.filter((model) => model.provider === "relay");
  if (relayModels.length) {
    try {
      const stations = await rows(
        db,
        `SELECT id::text, base_url, enabled, api_key_encrypted IS NOT NULL AS configured,
                probe_stats, updated_at
         FROM public.ai_relay_stations
         WHERE enabled AND api_key_encrypted IS NOT NULL`,
      );
      for (const st of stations) {
        const probeStats =
          st.probe_stats && typeof st.probe_stats === "object"
            ? (st.probe_stats as Record<string, { verifiedAt?: string | null }>)
            : {};
        let hostname = "";
        try {
          hostname = new URL(String(st.base_url)).hostname;
        } catch {
          continue;
        }
        const stationModels = relayModels.filter((m) => m.stationId === st.id);
        const receipts =
          hostname && stationModels.length
            ? await rows(
                db,
                `SELECT DISTINCT ON(u.model) u.model, u.status
                 FROM public.ai_model_usage u
                 WHERE u.source=$1 AND u.model=ANY($2::text[])
                   AND u.started_at >= $3::timestamptz
                   AND u.status IN ('success','failed','responded')
                 ORDER BY u.model, u.started_at DESC, u.id DESC`,
                hostname,
                stationModels.map((m) => m.actual),
                st.updated_at,
              )
            : [];
        for (const m of stationModels) {
          const probed = Boolean(probeStats[m.actual]?.verifiedAt);
          const recentOk = receipts.some(
            (r) => r.model === m.actual && r.status === "success",
          );
          if (probed || recentOk) result.add(m.id);
        }
      }
    } catch {
      /* Minimal unit tests may omit ai_relay_stations. */
    }
  }
  return result;
}
