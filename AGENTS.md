# Repository working agreement

## User manual maintenance

- Every user-facing feature, workflow, label, validation, permission, or integration-scope change must update the relevant `docs/manual/*.md` chapter in the same change. Read existing chapters before editing behavior.
- The authenticated `/api/v1/help` endpoint reads these Markdown files and filters by module permissions; `/help` consumes only the authorized response. Add new chapters to `apps/api/src/manual.ts` with the matching permission. Never bundle full manual text into public frontend assets. Do not maintain a second copy of manual content in frontend code.
- Add a chapter for every new functional module. Include entry point, prerequisites, steps, save/confirmation effects, important limitations, common failures, and an accurate revision date.
- Document implemented behavior, not planned capability. Never include production credentials or personal data.
- For changes with no user-visible impact, state why no manual update is needed in the change description.
- Validate manual text against actual UI/API behavior and run typecheck/build when changing the help UI or imports. Release manual updates with the corresponding application version.
