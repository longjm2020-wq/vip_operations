# DeerFlow private Gateway

This service pins ByteDance DeerFlow **v2.2.0**, commit `58fc5bd5b8e6ea46538e9481ba06ca2a46e14e2a`. Its MIT license is retained in the image. The ERP supplies the user interface and authenticates every user request; DeerFlow runs privately as a separate Railway service.

## Railway configuration

- Source: this repository, root build context; Dockerfile `services/deerflow/Dockerfile` (`RAILWAY_DOCKERFILE_PATH`).
- Name: `vip-deerflow`; one replica and one Gateway worker. Mount its dedicated persistent volume at `/data`.
- Health check: `/health/ready`, startup timeout 300 seconds. Do not generate a public domain or TCP proxy.
- Start with 2 vCPU / 4 GB RAM resource allowance for this Gateway-only service, then measure real usage. This is an integration sizing estimate, not the upstream complete-stack recommendation or a load-test result. Native code execution and the separate upstream frontend are not included.
- `ERP_API_BASE=http://vip-api.railway.internal:3100` (verify the existing API private hostname/port).
- Set distinct cryptographically random 32-byte hex secrets for `DEER_FLOW_INTERNAL_AUTH_TOKEN`, `DEER_FLOW_MODEL_PROXY_TOKEN`, and `AUTH_JWT_SECRET`. Never store their values in Git or user chat.
- API and Worker use the same `DEER_FLOW_INTERNAL_AUTH_TOKEN` as the Gateway; API uses the same `DEER_FLOW_MODEL_PROXY_TOKEN`. Prefer Railway reference variables to copying secrets. The ERP connector must send `X-DeerFlow-Internal-Token` and server-derived `X-DeerFlow-Owner-User-Id=erp-<userId>`.
- Native v2.2 also requires double-submit CSRF on internal state-changing requests. The connector sends a fresh cryptographically random value in both `Cookie: csrf_token=<value>` and `X-CSRF-Token` for every POST/PUT/PATCH/DELETE, matching the upstream channel client. It never forwards browser session cookies or an `Authorization` header. Successful authenticated GETs do not prove POST compatibility; a missing CSRF pair returns HTTP 403 before internal authentication.
- The ERP connection uses private origin `http://vip-deerflow.railway.internal:8001`. Keep port 8001, or update the connection to the actual `PORT`.

The startup code refuses missing/reused service credentials, a disabled authentication flag, or an unsafe model proxy origin. It initializes only its own data directories and drops root before loading the Gateway. Runtime data, accounts, thread files, checkpoints, and run events are retained in the service volume. Back up `/data` before upgrading. SQLite requires one replica; a multi-replica deployment needs a separate PostgreSQL design and shared file storage.

## Model and execution scope

DeerFlow calls the ERP's `/internal/deerflow/v1/chat/completions` with the fixed alias `erp-default`. That dedicated authenticated endpoint resolves the enabled, verified website AI service and the current orchestration model. The supplier API key stays encrypted in the existing ERP database and is decrypted only for the ERP's supplier request. It is not exported into DeerFlow. Requests have output, size, and time limits; the client and proxy do not automatically retry paid model calls.

The initial tool allowlist contains public search/fetch and thread-scoped file read/write. `allow_host_bash` is false, the bash tool and code-execution tools are absent, no Docker executable/socket is included, and no ERP database or filesystem is mounted. The upstream local sandbox is used only for validated file operations; it is not represented as an OS isolation boundary. Files such as Markdown, plain text, and CSV can be produced directly. Image/video generation, executing scripts, browser control, and modifying ERP business records are outside this initial configuration. Add a properly isolated remote execution provider and specific authorized tools before enabling those operations.

Only explicit task content and attachments are provided by the ERP integration. Per-user ownership comes from the authenticated ERP account; never accept the internal owner header from the public browser. Do not expose the upstream administration, model editor, or registration routes through a generic public reverse proxy.

## Validation and release

Run `python services/deerflow/test_start.py` and the TypeScript model-gateway tests. Build the Docker image in Railway (or locally with Docker), wait for `/health/ready`, then verify one real authenticated task, isolation between two user IDs, attachment delivery, and cancellation through the ERP connector. A healthy container alone is not proof that a real model task works. Deploy the API model proxy before enabling DeerFlow requests. Roll back by disabling the ERP DeerFlow connection and retaining the dedicated volume; do not delete task data or alter existing business databases.

For rollback, clear `DEER_FLOW_URL` on the **API only** to return new submissions to the original engine. Keep the Worker URL/internal token, API model-proxy token, and DeerFlow service running until existing remote tasks and cancellation reconciliation have settled. Only then stop the independent service. Clearing the Worker's connection at the same time would prevent it from checking or stopping remote tasks whose submission receipt was lost.
