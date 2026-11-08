# Repository working agreement

## User manual maintenance

- Every user-facing feature, workflow, label, validation, permission, or integration-scope change must update the relevant `docs/manual/*.md` chapter in the same change. Read existing chapters before editing behavior.
- The authenticated `/api/v1/help` endpoint reads these Markdown files and filters by module permissions; `/help` consumes only the authorized response. Add new chapters to `apps/api/src/manual.ts` with the matching permission. Never bundle full manual text into public frontend assets. Do not maintain a second copy of manual content in frontend code.
- Add a chapter for every new functional module. Include entry point, prerequisites, steps, save/confirmation effects, important limitations, common failures, and an accurate revision date.
- Document implemented behavior, not planned capability. Never include production credentials or personal data.
- For changes with no user-visible impact, state why no manual update is needed in the change description.
- Validate manual text against actual UI/API behavior and run typecheck/build when changing the help UI or imports. Release manual updates with the corresponding application version.

- Keep the shared coreFeatureSummary in apps/web/src/main.tsx aligned with the main implemented product capabilities when scope changes. Sidebar and footer must use the same summary; keep it concise and exclude planned features.

## AI model management maintenance

- Every new or changed feature that calls an AI model must update the central AI model management registry in the same change. Keep the feature name, direct entry route, effective model or routing policy, capability limits, API source, connection status, and token/credit/currency usage coverage aligned with the actual call path.
- A model selector must change the real configuration used by subsequent requests. Preserve capability checks and explicitly describe session-level overrides or provider-fixed models. Never present a catalog entry or saved credential as a successful model verification.
- Record provider-reported usage for new AI calls through the shared metering path. Distinguish unknown/unreported usage from zero, retain currencies and provider-specific credit units separately, and never invent historical usage or estimate it as an actual bill.
- Update the relevant user manual together with AI model management behavior. Include registry/routing/metering verification in the checks appropriate to the feature.
