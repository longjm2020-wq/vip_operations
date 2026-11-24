import { z } from "zod";
import {
  db,
  one,
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import { canonical, fail, hash, parse, type Context } from "../../core.js";
import {
  employeeMemberId,
  employeeProfileSchema,
  employeeSaveSchema,
  employeeTaskCreateSchema,
  employeeTaskSupplementSchema,
  type Employee,
  type EmployeeCatalog,
  type EmployeeDirectory,
  type EmployeeTask,
  type EmployeeTaskContext,
  type EmployeeProfile,
} from "../../../../../packages/contracts/src/assistant-employees.js";
import {
  defaultTeamSettings,
  type TeamMember,
  type TeamSettings,
  type TeamStep,
} from "../../../../../packages/contracts/src/assistant-team.js";
import { requireAssistant } from "./assistant-memory.js";
import { agentFileView, ownedAgentFiles } from "./agent-files.js";
import {
  cancelTeamRun,
  readTeamRun,
  runView,
  teamServiceReady,
} from "./assistant-team.js";
import { readTeamModelCatalog } from "./team-models.js";
import { publicTeamVideoCatalog } from "./team-video.js";

const uuid = z.string().uuid();
const active = "('QUEUED','PLANNING','RUNNING','REVIEWING')";
function employeeInputStatus(row: Row) {
  if (
    row.status !== "NEEDS_USER" ||
    row.state?.phase !== "awaiting_input" ||
    !row.state.inputRequestId
  )
    return {};
  return row.model_calls < row.max_model_calls
    ? { inputRequestId: row.state.inputRequestId as string }
    : { stage: "本单调用次数已达上限，核对结果后可另行交办" };
}

async function requireQueueSpace(tx: Tx, userId: string) {
  const count = await one(
    tx,
    `SELECT count(*)::int AS n FROM public.personal_assistant_employee_tasks t JOIN public.personal_assistant_team_runs r ON r.id=t.run_id
    WHERE t.user_id=$1::bigint AND r.status IN ${active}`,
    userId,
  );
  if (count!.n >= 30)
    fail(
      "EMPLOYEE_QUEUE_FULL",
      "已有30个未结束员工任务，请先完成或停止部分任务",
      409,
    );
}
export const maxEmployees = 18;
const profileView = (row: Row): Employee => ({
  ...employeeProfileSchema.parse(row.profile),
  id: row.id,
  version: row.version,
  archived: row.archived,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
  activeTasks: Number(row.active_tasks || 0),
  queuedTasks: Number(row.queued_tasks || 0),
});
export async function listEmployees(c: Context): Promise<EmployeeDirectory> {
  requireAssistant(c);
  const found = await rows(
    db,
    `SELECT e.*,
    (SELECT count(*) FROM public.personal_assistant_employee_tasks t JOIN public.personal_assistant_team_runs r ON r.id=t.run_id
      WHERE t.user_id=e.user_id AND e.id=ANY(t.employee_ids) AND r.status IN ('PLANNING','RUNNING','REVIEWING')) AS active_tasks,
    (SELECT count(*) FROM public.personal_assistant_employee_tasks t JOIN public.personal_assistant_team_runs r ON r.id=t.run_id
      WHERE t.user_id=e.user_id AND e.id=ANY(t.employee_ids) AND r.status='QUEUED') AS queued_tasks
    FROM public.personal_assistant_employees e WHERE e.user_id=$1::bigint ORDER BY e.created_at,e.id`,
    c.actor.id,
  );
  return { employees: found.map(profileView), maxEmployees };
}
export async function employeeCatalog(c: Context): Promise<EmployeeCatalog> {
  requireAssistant(c);
  const [catalog, ready, videoModels] = await Promise.all([
    readTeamModelCatalog(),
    teamServiceReady(),
    publicTeamVideoCatalog(c),
  ]);
  return {
    ...catalog,
    ready,
    videoModels,
    notice: ready
      ? "型号来自已配置目录；固定型号不会自动更换。实际可用性以连接验证和本次调用回执为准。"
      : "请先在 AI 模型管理中启用并验证共享创作服务。",
  };
}
async function validateModels(c: Context, profile: EmployeeProfile) {
  const catalog = await employeeCatalog(c);
  for (const [policy, models] of [
    [profile.workModel, catalog.models],
    [profile.imageModel, catalog.imageModels],
    [profile.videoModel, catalog.videoModels || []],
  ] as const) {
    if (policy.modelIds.some((id) => !models.some((model) => model.id === id)))
      fail(
        "EMPLOYEE_MODEL_UNAVAILABLE",
        "所选型号当前不在可用目录中，请刷新模型列表后核对",
        409,
      );
  }
}
export async function saveEmployee(
  c: Context,
  input: unknown,
): Promise<Employee> {
  requireAssistant(c);
  const body = parse(employeeSaveSchema, input);
  await validateModels(c, body.profile);
  const saved = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "assistant-employees:" + c.actor.id,
    );
    const previous = await one(
      tx,
      "SELECT user_id::text,version,archived FROM public.personal_assistant_employees WHERE id=$1::uuid FOR UPDATE",
      body.id,
    );
    if (previous && previous.user_id !== c.actor.id)
      fail("NOT_FOUND", "员工不存在", 404);
    if ((previous?.version || 0) !== body.version)
      fail(
        "VERSION_CONFLICT",
        "员工资料已在其他页面更新，请重新载入后核对",
        409,
      );
    if (!previous) {
      const count = await one(
        tx,
        "SELECT count(*)::int AS n FROM public.personal_assistant_employees WHERE user_id=$1::bigint AND NOT archived",
        c.actor.id,
      );
      if (count!.n >= maxEmployees)
        fail(
          "EMPLOYEE_LIMIT",
          `最多保留${maxEmployees}位在职员工，请先归档暂不用的员工`,
          409,
        );
    }
    return one(
      tx,
      `INSERT INTO public.personal_assistant_employees(id,user_id,profile) VALUES($1::uuid,$2::bigint,$3::jsonb)
      ON CONFLICT(id) DO UPDATE SET profile=EXCLUDED.profile,version=personal_assistant_employees.version+1,updated_at=now() RETURNING *`,
      body.id,
      c.actor.id,
      JSON.stringify(body.profile),
    );
  });
  return profileView(saved!);
}
export async function archiveEmployee(c: Context, id: string, input: unknown) {
  requireAssistant(c);
  parse(uuid, id);
  const body = parse(
    z
      .object({ version: z.number().int().positive(), archived: z.boolean() })
      .strict(),
    input,
  );
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "assistant-employees:" + c.actor.id,
    );
    const employee = await one(
      tx,
      "SELECT * FROM public.personal_assistant_employees WHERE id=$1::uuid AND user_id=$2::bigint FOR UPDATE",
      id,
      c.actor.id,
    );
    if (!employee) fail("NOT_FOUND", "员工不存在", 404);
    if (employee.version !== body.version)
      fail("VERSION_CONFLICT", "员工资料已变化，请刷新后核对", 409);
    if (body.archived) {
      const busy = await one(
        tx,
        `SELECT t.run_id FROM public.personal_assistant_employee_tasks t JOIN public.personal_assistant_team_runs r ON r.id=t.run_id
        WHERE t.user_id=$1::bigint AND $2::uuid=ANY(t.employee_ids) AND r.status IN ${active} LIMIT 1`,
        c.actor.id,
        id,
      );
      if (busy)
        fail(
          "EMPLOYEE_BUSY",
          "请先完成或停止该员工尚未结束的任务，再归档",
          409,
        );
    } else {
      const count = await one(
        tx,
        "SELECT count(*)::int AS n FROM public.personal_assistant_employees WHERE user_id=$1::bigint AND NOT archived AND id<>$2::uuid",
        c.actor.id,
        id,
      );
      if (count!.n >= maxEmployees)
        fail("EMPLOYEE_LIMIT", `在职员工已达到${maxEmployees}位`, 409);
    }
    const saved = await one(
      tx,
      "UPDATE public.personal_assistant_employees SET archived=$3,version=version+1,updated_at=now() WHERE id=$1::uuid AND user_id=$2::bigint RETURNING *",
      id,
      c.actor.id,
      body.archived,
    );
    return profileView(saved!);
  });
}

/** Server-generated snapshots, never a caller-supplied prompt or permission grant. */
export function employeeTeamSettings(
  context: EmployeeTaskContext,
): TeamSettings {
  const defaults = defaultTeamSettings();
  const review =
    context.origin === "dispatch"
      ? context.employees.find((e) => e.profile.kind === "review")
      : undefined;
  const asMember = (
    e: EmployeeTaskContext["employees"][number],
    coordinator = false,
  ): TeamMember => ({
    id: employeeMemberId(e.id),
    name: e.profile.name,
    role: coordinator
      ? "coordinator"
      : (
          {
            image: "designer",
            video: "video",
            writing: "writer",
            research: "researcher",
            review: "custom",
            custom: "custom",
          } as const
        )[e.profile.kind],
    instructions: e.profile.instructions,
    skill: e.profile.skill,
    enabled: true,
    modelMode: e.profile.workModel.mode === "auto" ? "auto" : "fixed",
    modelId: e.profile.workModel.modelIds[0],
    imageModelId: e.profile.imageModel.modelIds[0],
    videoModelId: e.profile.videoModel.modelIds[0],
  });
  const members = defaults.members
    .filter((m) =>
      ["orchestrator", "coordinator", "librarian"].includes(m.role),
    )
    .map((m) =>
      m.role === "coordinator" && review ? asMember(review, true) : m,
    );
  members.push(
    ...context.employees
      .filter((e) => e.id !== review?.id)
      .map((e) => asMember(e)),
  );
  return {
    ...defaults,
    engine: "native",
    members,
    maxSteps: Math.min(
      12,
      context.origin === "direct"
        ? context.employees[0].profile.maxSteps
        : Math.max(4, context.employees.length * 2),
    ),
    maxRevisions: Math.max(
      ...context.employees.map((e) => e.profile.maxRevisions),
    ),
    concurrency: context.origin === "direct" ? 1 : 3,
  };
}
async function taskMetadata(c: Context, id: string) {
  parse(uuid, id);
  const row = await one(
    db,
    "SELECT * FROM public.personal_assistant_employee_tasks WHERE run_id=$1::uuid AND user_id=$2::bigint",
    id,
    c.actor.id,
  );
  if (!row) fail("NOT_FOUND", "员工任务不存在", 404);
  return row;
}
export async function readEmployeeTask(
  c: Context,
  id: string,
): Promise<EmployeeTask> {
  requireAssistant(c);
  const meta = await taskMetadata(c, id);
  const run = await readTeamRun(c, id, "employee");
  const mediaJobs = await rows(
    db,
    "SELECT id,title,kind,model,status,stage FROM public.personal_assistant_jobs WHERE request_id=$1::uuid AND user_id=$2::bigint ORDER BY created_at LIMIT 72",
    id,
    c.actor.id,
  );
  const stored = await one(
    db,
    "SELECT input,state,status FROM public.personal_assistant_team_runs WHERE id=$1::uuid AND user_id=$2::bigint",
    id,
    c.actor.id,
  );
  const files = await rows(
    db,
    "SELECT id,name,mime,size,source,metadata,created_at FROM public.personal_assistant_files WHERE user_id=$1::bigint AND id=ANY($2::uuid[])",
    c.actor.id,
    stored!.input.attachmentIds || [],
  );
  return {
    ...run,
    ...employeeInputStatus({ ...meta, ...stored }),
    mediaJobs: mediaJobs.map((job) => ({
      id: job.id,
      title: job.title,
      kind: job.kind,
      model: job.model,
      status: job.status,
      stage: job.stage,
    })),
    origin: meta.origin,
    employeeId: meta.employee_id || undefined,
    employeeIds: meta.employee_ids,
    paused: meta.paused,
    modelCalls: meta.model_calls,
    maxModelCalls: meta.max_model_calls,
    profiles: stored!.input.employeeContext.employees,
    attachments: files.map(agentFileView),
  };
}
export async function listEmployeeTasks(
  c: Context,
  employeeId?: string,
): Promise<EmployeeTask[]> {
  requireAssistant(c);
  if (employeeId) parse(uuid, employeeId);
  const list = await rows(
    db,
    `SELECT r.*,t.employee_id,t.employee_ids,t.origin,t.paused,t.model_calls,t.max_model_calls,
      ARRAY(SELECT DISTINCT jsonb_array_elements_text(a.file_ids) FROM public.personal_assistant_team_artifacts a
        WHERE a.run_id=r.id AND a.user_id=t.user_id AND a.status='ACCEPTED') AS result_file_ids
    FROM public.personal_assistant_employee_tasks t JOIN public.personal_assistant_team_runs r ON r.id=t.run_id AND r.user_id=t.user_id
    WHERE t.user_id=$1::bigint AND ($2::uuid IS NULL OR $2::uuid=ANY(t.employee_ids)) ORDER BY r.created_at DESC LIMIT 30`,
    c.actor.id,
    employeeId || null,
  );
  const ids = [
    ...new Set(
      list.flatMap(
        (row) =>
          [...row.input.attachmentIds, ...row.result_file_ids] as string[],
      ),
    ),
  ];
  const files = ids.length
    ? await rows(
        db,
        "SELECT id,name,mime,size,source,metadata,created_at FROM public.personal_assistant_files WHERE user_id=$1::bigint AND id=ANY($2::uuid[])",
        c.actor.id,
        ids,
      )
    : [];
  return list.map((row) => ({
    ...runView(row, []),
    ...employeeInputStatus(row),
    members: [],
    steps: [],
    summaryOnly: true,
    stepCount: row.state.steps?.length || 0,
    completedSteps:
      row.state.steps?.filter((s: { status: string }) => s.status === "DONE")
        .length || 0,
    origin: row.origin,
    employeeId: row.employee_id || undefined,
    employeeIds: row.employee_ids,
    paused: row.paused,
    modelCalls: row.model_calls,
    maxModelCalls: row.max_model_calls,
    attachments: files
      .filter((f) => row.input.attachmentIds.includes(f.id))
      .map(agentFileView),
    resultFiles: files
      .filter((f) => row.result_file_ids.includes(f.id))
      .map(agentFileView),
    profiles: (row.input.employeeContext as EmployeeTaskContext).employees.map(
      (e) => ({
        id: e.id,
        version: e.version,
        profile: { name: e.profile.name, kind: e.profile.kind },
      }),
    ),
  }));
}
export async function createEmployeeTask(
  c: Context,
  input: unknown,
): Promise<EmployeeTask> {
  requireAssistant(c);
  const body = parse(employeeTaskCreateSchema, input),
    requestHash = hash(canonical(body));
  const previous = await one(
    db,
    `SELECT r.request_hash FROM public.personal_assistant_team_runs r
    JOIN public.personal_assistant_employee_tasks t ON t.run_id=r.id WHERE r.id=$1::uuid AND r.user_id=$2::bigint`,
    body.id,
    c.actor.id,
  );
  if (previous) {
    if (previous.request_hash !== requestHash)
      fail("IDEMPOTENCY_CONFLICT", "任务标识已用于其他内容", 409);
    return readEmployeeTask(c, body.id);
  }
  if (!(await teamServiceReady()))
    fail(
      "EMPLOYEE_UNAVAILABLE",
      "员工创作服务尚未启用或验证，请检查 AI 模型管理",
      409,
    );
  await ownedAgentFiles(c, body.attachmentIds);
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "assistant-employees:" + c.actor.id,
    );
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "assistant-team-run:" + body.id,
    );
    const exists = await one(
      tx,
      "SELECT user_id::text,request_hash FROM public.personal_assistant_team_runs WHERE id=$1::uuid",
      body.id,
    );
    if (exists) {
      if (exists.user_id !== c.actor.id || exists.request_hash !== requestHash)
        fail("IDEMPOTENCY_CONFLICT", "任务标识已被使用", 409);
      return;
    }
    const requested = body.employeeId ? [body.employeeId] : body.employeeIds;
    const found = await rows(
      tx,
      `SELECT * FROM public.personal_assistant_employees WHERE user_id=$1::bigint AND NOT archived
      AND (cardinality($2::uuid[])=0 OR id=ANY($2::uuid[])) ORDER BY created_at,id`,
      c.actor.id,
      requested,
    );
    if (requested.length && found.length !== requested.length)
      fail("NOT_FOUND", "所选员工不存在或已经归档", 404);
    const selected = found.filter(
      (row) =>
        body.employeeId || (row.profile.allowDispatch && row.profile.accepting),
    );
    if (
      requested.length &&
      !body.employeeId &&
      selected.length !== requested.length
    )
      fail(
        "EMPLOYEE_DISPATCH_DISABLED",
        "所选员工已暂停接单或关闭主控调度，请重新选择",
        409,
      );
    if (!selected.length)
      fail("EMPLOYEE_MISSING", "请先新建员工，并启用允许主控调度与接单", 409);
    await requireQueueSpace(tx, c.actor.id);
    const snapshots = selected.map((row) => ({
      id: row.id,
      version: row.version,
      profile: employeeProfileSchema.parse(row.profile),
    }));
    const employeeContext: EmployeeTaskContext = {
      origin: body.employeeId ? "direct" : "dispatch",
      employeeId: body.employeeId,
      employees: snapshots,
      maxModelCalls: Math.min(
        120,
        body.employeeId
          ? snapshots[0].profile.maxModelCalls
          : snapshots.reduce((n, e) => n + e.profile.maxModelCalls, 0),
      ),
    };
    const settings = employeeTeamSettings(employeeContext);
    if (
      !settings.members.some(
        (m) =>
          m.enabled &&
          !["orchestrator", "coordinator", "librarian"].includes(m.role),
      )
    )
      fail(
        "EMPLOYEE_EXECUTOR_MISSING",
        "协作任务还需要一位执行员工；也可直接向质检员交办独立审核任务",
        409,
      );
    // Context is restricted to this employee's own previous deliveries; no main chat or other employees' private threads.
    const history = body.employeeId
      ? await rows(
          tx,
          `SELECT r.input->>'goal' AS goal,r.summary FROM public.personal_assistant_employee_tasks t
      JOIN public.personal_assistant_team_runs r ON r.id=t.run_id WHERE t.user_id=$1::bigint AND t.employee_id=$2::uuid
      AND r.status='DONE' AND NOT EXISTS (
        SELECT 1 FROM public.personal_assistant_team_artifacts a,
          LATERAL jsonb_array_elements(a.citations) AS source
        WHERE a.run_id=r.id AND a.user_id=r.user_id AND source->>'url' LIKE '/my-workspace?assistant=knowledge&%'
      ) ORDER BY r.created_at DESC LIMIT 6`,
          c.actor.id,
          body.employeeId,
        )
      : [];
    const conversationContext = JSON.stringify(
      history.reverse().flatMap((row) => [
        { role: "user", text: String(row.goal).slice(0, 1200) },
        { role: "assistant", text: String(row.summary).slice(0, 1200) },
      ]),
    );
    await tx.$executeRawUnsafe(
      "INSERT INTO public.personal_assistant_team_runs(id,user_id,request_hash,input,state,stage) VALUES($1::uuid,$2::bigint,$3,$4::jsonb,$5::jsonb,$6)",
      body.id,
      c.actor.id,
      requestHash,
      JSON.stringify({
        id: body.id,
        goal: body.goal,
        attachmentIds: body.attachmentIds,
        useKnowledge: false,
        engine: "native",
        settings,
        settingsVersion: 1,
        employeeContext,
        conversationContext,
      }),
      JSON.stringify({ plan: "", steps: [], members: settings.members }),
      "等待员工调度",
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO public.personal_assistant_employee_tasks(run_id,user_id,employee_id,employee_ids,origin,priority,max_model_calls)
      VALUES($1::uuid,$2::bigint,$3::uuid,$4::uuid[],$5,$6,$7)`,
      body.id,
      c.actor.id,
      body.employeeId || null,
      snapshots.map((e) => e.id),
      employeeContext.origin,
      Math.max(...snapshots.map((e) => e.profile.priority)),
      employeeContext.maxModelCalls,
    );
  });
  return readEmployeeTask(c, body.id);
}
export async function supplementEmployeeTask(
  c: Context,
  id: string,
  input: unknown,
) {
  requireAssistant(c);
  parse(uuid, id);
  const body = parse(employeeTaskSupplementSchema, input);
  const receipt = hash(canonical(body));
  await db.$transaction(async (tx) => {
    // Serialize with new assignments and employee archival as this run re-enters the queue.
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "assistant-employees:" + c.actor.id,
    );
    const run = await one(
      tx,
      `SELECT r.input,r.state,r.status,t.employee_ids,t.model_calls,t.max_model_calls
      FROM public.personal_assistant_team_runs r JOIN public.personal_assistant_employee_tasks t ON t.run_id=r.id AND t.user_id=r.user_id
      WHERE r.id=$1::uuid AND r.user_id=$2::bigint FOR UPDATE OF r,t`,
      id,
      c.actor.id,
    );
    if (!run) fail("NOT_FOUND", "员工任务不存在", 404);
    const receipts = run.input.supplementReceipts || {};
    if (receipts[body.requestId] === receipt) return;
    if (employeeInputStatus(run).inputRequestId !== body.requestId)
      fail(
        "EMPLOYEE_INPUT_CHANGED",
        "这次补充请求已结束，请刷新查看任务的最新进度",
        409,
      );
    const steps: TeamStep[] = run.state.steps;
    if (
      steps.some(
        (s) =>
          s.status !== "DONE" &&
          (s.status !== "NEEDS_USER" ||
            !s.needsInput ||
            s.jobIds.length ||
            s.artifactIds.length),
      )
    )
      fail(
        "EMPLOYEE_TASK_ENDED",
        "任务已有需要核对的执行记录，请先查看进度与产物",
        409,
      );
    const archived = await one(
      tx,
      "SELECT id FROM public.personal_assistant_employees WHERE user_id=$1::bigint AND id=ANY($2::uuid[]) AND archived LIMIT 1",
      c.actor.id,
      run.employee_ids,
    );
    if (archived)
      fail("EMPLOYEE_ARCHIVED", "参与任务的员工已归档，请先恢复员工", 409);
    await requireQueueSpace(tx, c.actor.id);
    const originalIds: string[] = run.input.attachmentIds;
    const attachmentIds = [...new Set([...originalIds, ...body.attachmentIds])];
    if (!body.text && attachmentIds.length === originalIds.length)
      fail("EMPLOYEE_INPUT_EMPTY", "请添加新的素材或填写补充说明", 400);
    if (attachmentIds.length > 6)
      fail("EMPLOYEE_FILES_LIMIT", "原任务与新素材合计最多六份", 400);
    const files = await rows(
      tx,
      "SELECT id FROM public.personal_assistant_files WHERE user_id=$1::bigint AND id=ANY($2::uuid[])",
      c.actor.id,
      attachmentIds,
    );
    if (files.length !== attachmentIds.length)
      fail("FILE_NOT_FOUND", "附件不存在或不属于当前账号", 404);
    const goal = body.text
      ? run.input.goal + "\n\n补充说明：" + body.text
      : run.input.goal;
    if (goal.length > 8000)
      fail(
        "EMPLOYEE_GOAL_LIMIT",
        "原任务与补充说明合计最多8000字，请缩短补充说明",
        400,
      );
    const state = {
      ...run.state,
      inputRequestId: undefined,
      phase: steps.length ? "execute" : "plan",
      employeePaused: steps.length > 0,
      steps: steps.map((s) =>
        s.status === "DONE"
          ? s
          : {
              ...s,
              status: "PENDING",
              needsInput: undefined,
              error: undefined,
              attempts: 0,
            },
      ),
    };
    await tx.$executeRawUnsafe(
      `UPDATE public.personal_assistant_team_runs SET input=$3::jsonb,state=$4::jsonb,
      status='QUEUED',stage='已收到补充资料，等待员工',summary='',error_note='',lease_id=NULL,heartbeat_at=NULL,updated_at=now()
      WHERE id=$1::uuid AND user_id=$2::bigint`,
      id,
      c.actor.id,
      JSON.stringify({
        ...run.input,
        goal,
        attachmentIds,
        supplementReceipts: { ...receipts, [body.requestId]: receipt },
      }),
      JSON.stringify(state),
    );
    await tx.$executeRawUnsafe(
      "UPDATE public.personal_assistant_employee_tasks SET paused=false WHERE run_id=$1::uuid AND user_id=$2::bigint",
      id,
      c.actor.id,
    );
  });
  return readEmployeeTask(c, id);
}

export async function controlEmployeeTask(
  c: Context,
  id: string,
  input: unknown,
) {
  requireAssistant(c);
  const body = parse(
    z.object({ action: z.enum(["pause", "resume", "stop"]) }).strict(),
    input,
  );
  await taskMetadata(c, id);
  if (body.action === "stop") {
    await cancelTeamRun(c, id, "employee");
    return readEmployeeTask(c, id);
  }
  const changed = await one(
    db,
    `UPDATE public.personal_assistant_employee_tasks t SET paused=$3
    FROM public.personal_assistant_team_runs r WHERE r.id=t.run_id AND t.run_id=$1::uuid AND t.user_id=$2::bigint
    AND r.status IN ${active} RETURNING t.run_id`,
    id,
    c.actor.id,
    body.action === "pause",
  );
  if (!changed)
    fail(
      "EMPLOYEE_TASK_ENDED",
      "任务已结束或需要核对，不能直接重放；请核对已有结果后另行交办",
      409,
    );
  return readEmployeeTask(c, id);
}
