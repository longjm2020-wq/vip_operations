import { useRef, useState, type FormEvent } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Tag,
} from "antd";
import {
  DownloadOutlined,
  LoadingOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  bailianCommerceVoiceModels,
  type BailianCommerceVoiceCatalog,
  type BailianCommerceVoiceModel,
} from "../../../../packages/contracts/src/bailian-commerce-voice";
import { useUser } from "../shared";
import { studioApi } from "./api";
import {
  CommerceBailianVoice,
  bailianVoiceModelLabel,
} from "./commerce-bailian-voice";
import { LipSync, useLipSync, type LipSyncQuery } from "./lip-sync";
import { CommerceTalkWorkflow } from "./talk-workflow";
import "./talk-video.css";

const path = "/commerce-video";
const promptLimit = 800;
const photoLimit = 4;

type Named = { id: string; name: string };
type Photo = { id: string; url: string; color?: string };
type Product = Named & { styleNo: string; images: Photo[] };
type Presenter = Named & {
  voiceKind: "default" | "cloned";
  voiceProvider?: "agentai" | "bailian";
  voiceModel?: BailianCommerceVoiceModel;
  engine?: "fal";
};
type Voice = Named & {
  kind: "default" | "cloned";
  provider?: "agentai" | "bailian";
  model?: BailianCommerceVoiceModel;
};
type Avatar = Named & { engine?: "fal" };
type Options = {
  available: boolean;
  presenters: Presenter[];
  avatars: Avatar[];
  voices: Voice[];
  templates: Named[];
  canClone?: boolean;
  bailian?: BailianCommerceVoiceCatalog;
  readiness?: {
    script: boolean;
    presenter: boolean;
    fal: boolean;
    profile: boolean;
    issues: string[];
  };
};
type Scene = {
  caption: string;
  imageId?: string | null;
  imageUrl?: string;
  start?: number;
  end?: number;
};
type JobState =
  | "queued"
  | "writing"
  | "speaking"
  | "editing"
  | "completed"
  | "failed"
  | "uncertain";
type Job = {
  id: string;
  productId: string;
  styleNo: string;
  presenterName: string;
  prompt: string;
  state: JobState;
  editable?: boolean;
  message?: string;
  scenes: Scene[];
  videoUrl?: string;
  downloadUrl?: string;
  createdAt: string;
};
type Batch = {
  id: string;
  createdAt: string;
  items: Array<{ productId: string; styleNo?: string; job?: Job; message?: string }>;
};

const labels: Record<JobState, string> = {
  queued: "排队中",
  writing: "正在策划口播",
  speaking: "正在生成口播",
  editing: "正在剪辑",
  completed: "已完成",
  failed: "生成失败",
  uncertain: "结果待核实",
};

function isActive(state?: JobState) {
  return (
    state === "queued" ||
    state === "writing" ||
    state === "speaking" ||
    state === "editing"
  );
}

function shortError(error: unknown) {
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}

function jobKey(account: string, id?: string | null) {
  return ["commerce-video", account, "job", id];
}

function productLabel(product: Product) {
  return product.name && product.name !== product.styleNo
    ? `${product.styleNo} · ${product.name}`
    : product.styleNo;
}

export function TalkVideo() {
  const user = useUser();
  const account = String(user.id);
  const canUseCommerce = user.permissions.includes("product.read");
  const [params] = useSearchParams();
  const location = useLocation();
  const connection = useLipSync(account);
  const linkedCommerce = Boolean(
    params.has("product") ||
    params.has("job") ||
    params.has("batch") ||
    params.get("scope") === "batch" ||
    params.has("prompt") ||
    location.state?.talkVideoPrompt,
  );
  if (
    canUseCommerce &&
    !linkedCommerce &&
    !params.has("mode") &&
    connection.isPending
  ) {
    return (
      <section className="talk-video">
        <p className="talk-video-state" role="status">
          <LoadingOutlined /> 正在读取口播服务
        </p>
      </section>
    );
  }
  return (
    <TalkVideoWorkspace
      key={account}
      account={account}
      canUseCommerce={canUseCommerce}
      linkedCommerce={linkedCommerce}
      connection={connection}
    />
  );
}

type TalkMode = "lip-sync" | "commerce" | "workflow";

function TalkVideoWorkspace({
  account,
  canUseCommerce,
  linkedCommerce,
  connection,
}: {
  account: string;
  canUseCommerce: boolean;
  linkedCommerce: boolean;
  connection: LipSyncQuery;
}) {
  const [params, setParams] = useSearchParams();
  const [defaultMode] = useState<TalkMode>(() =>
    connection.data?.configured ? "lip-sync" : "commerce",
  );
  const selected = params.get("mode");
  const hasWorkflowLink = Boolean(
    params.has("workflow") || params.get("extImport") === "1",
  );
  const mode: TalkMode = !canUseCommerce
    ? "lip-sync"
    : selected === "workflow" || hasWorkflowLink
      ? "workflow"
      : selected === "lip-sync"
        ? "lip-sync"
        : selected === "commerce" || linkedCommerce
          ? "commerce"
          : defaultMode;
  const portrait = mode === "lip-sync";
  const isWorkflow = mode === "workflow";
  return (
    <section
      className={`talk-video${isWorkflow ? " talk-video-workbench" : ""}`}
      aria-labelledby="talk-video-title"
    >
      <div className="talk-video-topbar">
        <header className="talk-video-heading">
          <h1 id="talk-video-title">
            {portrait ? "数字人口播" : isWorkflow ? "服装口播 · 爆款复刻工作流" : "服装口播"}
          </h1>
          {!isWorkflow && (
            <p>
              {portrait
                ? "上传人物照片和原声录音，生成对口型视频。"
                : "选款并填写拍摄要求，生成带字幕的竖屏视频。"}
            </p>
          )}
        </header>
        {canUseCommerce && (
          <Segmented<TalkMode>
            className="talk-video-modes"
            aria-label="口播制作方式"
            value={mode}
            options={[
              { value: "lip-sync", label: "原声对口型" },
              { value: "commerce", label: "商品口播" },
              { value: "workflow", label: "爆款复刻工作流" },
            ]}
            onChange={(value) =>
              setParams(
                (current) => {
                  const next = new URLSearchParams(current);
                  next.set("mode", value);
                  return next;
                },
                { replace: true },
              )
            }
          />
        )}
      </div>
      {portrait ? (
        <LipSync account={account} connection={connection} />
      ) : isWorkflow ? (
        <CommerceTalkWorkflow account={account} />
      ) : (
        <CommerceTalkVideo account={account} fal={connection.data} />
      )}
    </section>
  );
}

function CommerceTalkVideo({
  account,
  fal,
}: {
  account: string;
  fal?: LipSyncQuery["data"];
}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const client = useQueryClient();
  const optionsKey = ["commerce-video", account, "options"];
  const taskListKey = ["commerce-video", account, "jobs"];
  const productId = params.get("product") || undefined;
  const jobId = params.get("job");
  const batchId = params.get("batch");
  const batchMode = params.get("scope") === "batch" || Boolean(batchId);
  const [batchProducts, setBatchProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState(() => {
    const chatPrompt: unknown = location.state?.talkVideoPrompt;
    return (
      typeof chatPrompt === "string" ? chatPrompt : params.get("prompt") || ""
    ).slice(0, promptLimit);
  });
  const [presenterId, setPresenterId] = useState<string>();
  const [maxSpeechCny, setMaxSpeechCny] = useState<number | null>(null);
  const [photos, setPhotos] = useState<{ productId: string; ids: string[] }>();
  const [addingPresenter, setAddingPresenter] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const postingNow = useRef(false);

  const options = useQuery<Options>({
    queryKey: optionsKey,
    queryFn: ({ signal }) =>
      studioApi(`${path}/options`, "GET", undefined, { signal }),
  });
  const products = useQuery<{ products: Product[] }>({
    queryKey: ["commerce-video", account, "products", search],
    queryFn: ({ signal }) =>
      studioApi(
        `${path}/products?${new URLSearchParams({ q: search })}`,
        "GET",
        undefined,
        { signal },
      ),
    enabled: search.trim().length > 0,
  });
  const product = useProduct(account, productId);
  const history = useQuery<{ jobs: Job[] }>({
    queryKey: taskListKey,
    queryFn: ({ signal }) =>
      studioApi(`${path}/jobs`, "GET", undefined, { signal }),
  });
  const batchKey = ["commerce-video", account, "batch", batchId];
  const batchesKey = ["commerce-video", account, "batches"];
  const batch = useQuery<Batch>({
    queryKey: batchKey,
    queryFn: ({ signal }) => studioApi(`${path}/batches/${encodeURIComponent(batchId!)}`, "GET", undefined, { signal }),
    enabled: Boolean(batchId),
    refetchInterval: ({ state }) => state.data?.items.some(({ job }) => isActive(job?.state)) ? 4000 : false,
  });
  const batchHistory = useQuery<{ batches: Array<{ id: string; createdAt: string; count: number }> }>({
    queryKey: batchesKey,
    queryFn: ({ signal }) => studioApi(`${path}/batches`, "GET", undefined, { signal }),
    enabled: batchMode,
  });
  const job = useQuery<Job>({
    queryKey: jobKey(account, jobId),
    queryFn: ({ signal }) =>
      studioApi(
        `${path}/jobs/${encodeURIComponent(jobId!)}`,
        "GET",
        undefined,
        { signal },
      ),
    enabled: Boolean(jobId),
    refetchInterval: (query) =>
      isActive(query.state.data?.state) ? 4000 : false,
  });
  const foundProducts = products.data?.products || [];
  const batchProductOptions = [...new Map([...batchProducts, ...foundProducts].map((item) => [item.id, item])).values()];
  const pickerProducts =
    product.data &&
    !foundProducts.some((value) => value.id === product.data?.id)
      ? [product.data, ...foundProducts]
      : foundProducts;
  const presenters = options.data?.presenters || [];
  const selectedPresenter =
    presenters.find((presenter) => presenter.id === presenterId) ||
    presenters[0];
  const productPhotos = product.data?.images || [];
  const selectedPhotos =
    photos?.productId === productId
      ? photos?.ids || []
      : productPhotos.slice(0, 1).map((photo) => photo.id);
  const needsSpeechBudget = selectedPresenter?.voiceKind === "cloned";
  const usesFal = selectedPresenter?.engine === "fal";
  const falDuration = `${fal?.minSeconds ?? 5}～${fal?.maxSeconds ?? 15} 秒`;
  const speechPrice = bailianCommerceVoiceModels.find(
    (entry) => entry.id === selectedPresenter?.voiceModel,
  );
  const canSubmit = Boolean(
    options.data?.available &&
    (batchMode ? batchProducts.length >= 2 : product.data && selectedPhotos.length) &&
    selectedPresenter &&
    draft.trim().length >= 3 &&
    (!needsSpeechBudget ||
      (maxSpeechCny != null && maxSpeechCny > 0 && maxSpeechCny <= 20)),
  );

  function selectProduct(id?: string) {
    setError("");
    setSearch("");
    setPhotos(undefined);
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (id) next.set("product", id);
        else next.delete("product");
        return next;
      },
      { replace: true },
    );
  }

  function openJob(value: Job) {
    client.setQueryData(jobKey(account, value.id), value);
    if (jobId === value.id && !params.has("prompt")) return;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("job", value.id);
      next.delete("prompt");
      return next;
    });
  }

  function openBatch(id: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("scope", "batch");
      next.set("batch", id);
      next.delete("job");
      next.delete("prompt");
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || postingNow.current || !selectedPresenter || (!batchMode && !productId))
      return;
    const body = {
      ...(batchMode ? { productIds: batchProducts.map((item) => item.id) } : { productId, imageIds: selectedPhotos }),
      presenterId: selectedPresenter.id,
      prompt: draft.trim(),
      ...(needsSpeechBudget && { maxSpeechCny }),
    };
    const fingerprint = JSON.stringify(body);
    if (request.current?.fingerprint !== fingerprint) {
      request.current = { fingerprint, id: crypto.randomUUID() };
    }
    postingNow.current = true;
    setPosting(true);
    setError("");
    try {
      const payload = { ...body, requestId: request.current.id };
      if (batchMode) {
        const created: Batch = await studioApi(`${path}/batches`, "POST", payload);
        client.setQueryData(["commerce-video", account, "batch", created.id], created);
        openBatch(created.id);
        void client.invalidateQueries({ queryKey: batchesKey });
      } else {
        const created: Job = await studioApi(`${path}/jobs`, "POST", payload);
        openJob(created);
      }
      request.current = null;
      void client.invalidateQueries({ queryKey: taskListKey });
    } catch (failure) {
      setError(shortError(failure));
    } finally {
      postingNow.current = false;
      setPosting(false);
    }
  }

  const currentJob = job.data;
  const recent = history.data?.jobs || [];
  const readiness = options.data?.readiness;
  const issues = readiness?.issues || [];
  const hasReadyServices = options.data?.available;
  const needsPresenter = hasReadyServices && presenters.length === 0;
  const canManagePresenters = readiness?.fal || readiness?.presenter;
  return (
    <>
      {options.isError && (
        <Alert
          className="talk-video-notice"
          type="error"
          showIcon
          title={shortError(options.error)}
          action={
            <Button size="small" onClick={() => void options.refetch()}>
              重试
            </Button>
          }
        />
      )}
      {options.data && (!hasReadyServices || needsPresenter) && (
        <Alert
          className="talk-video-notice"
          type="info"
          showIcon
          title={
            needsPresenter
              ? "请先保存一个主播"
              : readiness
                ? "完成以下设置后可生成商品口播"
                : "生成服务尚未就绪。请管理员检查脚本与数字人口播服务。"
          }
          description={
            issues.length > 0 && (
              <ul className="talk-video-readiness">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )
          }
          action={
            <div className="talk-video-readiness-actions">
              {(needsPresenter ||
                (!readiness?.profile && canManagePresenters)) && (
                <Button size="small" onClick={() => setAddingPresenter(true)}>
                  去设置主播
                </Button>
              )}
              <Button size="small" onClick={() => void options.refetch()}>
                重新检查
              </Button>
            </div>
          }
        />
      )}
      <form className="talk-video-composer" onSubmit={submit}>
        <Segmented
          className="talk-video-scope"
          aria-label="口播任务范围"
          value={batchMode ? "batch" : "single"}
          options={[{ value: "single", label: "单款" }, { value: "batch", label: "按款批量" }]}
          disabled={posting}
          onChange={(value) => {
            setError("");
            setSearch("");
            setParams((previous) => {
              const next = new URLSearchParams(previous);
              if (value === "batch") {
                next.set("scope", "batch");
                next.delete("job");
              } else {
                next.delete("scope");
                next.delete("batch");
              }
              return next;
            });
          }}
        />
        <Input.TextArea
          aria-label="视频要求"
          value={draft}
          placeholder={
            usesFal
              ? "例如：拍一条约 10 秒的通勤口播，先看版型，再讲一句袖口细节。"
              : "例如：给这款外套拍一条通勤口播，开头直接讲版型，中间展示领口和袖口。"
          }
          autoSize={{ minRows: 2, maxRows: 5 }}
          maxLength={promptLimit}
          onChange={(event) => setDraft(event.target.value)}
          disabled={posting}
        />
        <div className="talk-video-fields">
          {batchMode ? (
            <Select
              className="talk-video-batch-picker"
              aria-label="批量选择商品"
              mode="multiple"
              maxCount={10}
              virtual={false}
              showSearch
              filterOption={false}
              loading={products.isFetching}
              disabled={posting}
              placeholder="搜索并选 2 至 10 个款号"
              value={batchProducts.map((item) => item.id)}
              onSearch={setSearch}
              onChange={(ids) => setBatchProducts(ids.flatMap((id: string) => {
                const item = batchProductOptions.find((product) => product.id === id);
                return item ? [item] : [];
              }))}
              options={batchProductOptions.map((item) => ({ value: item.id, label: productLabel(item) }))}
              notFoundContent={products.isError ? shortError(products.error) : search ? "没有找到匹配的款式" : "输入款号"}
            />
          ) : <Select
            aria-label="商品"
            showSearch
            allowClear
            filterOption={false}
            loading={product.isLoading || products.isFetching}
            disabled={posting}
            placeholder="搜索款号"
            value={productId}
            onSearch={setSearch}
            onChange={selectProduct}
            options={pickerProducts.map((value) => ({
              value: value.id,
              label: productLabel(value),
            }))}
            notFoundContent={
              products.isError
                ? shortError(products.error)
                : search
                  ? "没有找到匹配的款式"
                  : "输入款号"
            }
          />}
          {presenters.length > 0 && (
            <Select
              aria-label="主播"
              value={selectedPresenter?.id}
              disabled={posting}
              onChange={(id) => setPresenterId(id)}
              options={presenters.map(({ id, name }) => ({
                value: id,
                label: name,
              }))}
            />
          )}
          {options.data && (
            <Button
              size="small"
              type="text"
              onClick={() => setAddingPresenter(true)}
              disabled={posting}
            >
              {presenters.length ? "管理主播" : "设置主播"}
            </Button>
          )}
          {!batchMode && productPhotos.length > 0 && (
            <details className="talk-video-photo-picker">
              <summary>商品图 {selectedPhotos.length} 张</summary>
              <div aria-label="选择商品图" className="talk-video-photos">
                {productPhotos.map((photo, index) => (
                  <label key={photo.id}>
                    <img
                      src={photo.url}
                      loading="lazy"
                      alt={photo.color || `商品图 ${index + 1}`}
                    />
                    <input
                      type="checkbox"
                      aria-label={`使用商品图 ${index + 1}${photo.color ? `（${photo.color}）` : ""}`}
                      checked={selectedPhotos.includes(photo.id)}
                      disabled={
                        posting ||
                        (!selectedPhotos.includes(photo.id) &&
                          selectedPhotos.length >= photoLimit)
                      }
                      onChange={(event) =>
                        setPhotos({
                          productId: product.data!.id,
                          ids: event.target.checked
                            ? [...selectedPhotos, photo.id]
                            : selectedPhotos.filter((id) => id !== photo.id),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </details>
          )}
          {needsSpeechBudget && (
            <InputNumber
              aria-label={batchMode ? "每款克隆配音预算上限（元）" : "克隆配音预算上限（元）"}
              placeholder="配音预算上限"
              min={0.01}
              max={20}
              precision={2}
              value={maxSpeechCny}
              suffix="元"
              disabled={posting}
              onChange={setMaxSpeechCny}
            />
          )}
          <Button
            className="talk-video-submit"
            htmlType="submit"
            type="primary"
            icon={<VideoCameraOutlined />}
            loading={posting}
            disabled={!canSubmit}
          >
            {batchMode ? "提交批量制作" : "生成视频"}
          </Button>
        </div>
        {!batchMode && product.isError && (
          <p className="talk-video-state" role="status">
            {shortError(product.error)}
          </p>
        )}
        {!batchMode && product.data && !productPhotos.length && (
          <p className="talk-video-state" role="status">
            请先在商品档案里添加这款衣服的实拍图。
          </p>
        )}
        {!batchMode && productPhotos.length > 0 && !selectedPhotos.length && (
          <p className="talk-video-state" role="status">
            至少选择一张商品图。
          </p>
        )}
        {batchMode && (
          <p className="talk-video-state">
            每款独立制作，使用首张可用商品图。缺图的款号会单独记录。{needsSpeechBudget ? "配音预算按每款计算。" : ""}
          </p>
        )}
        {options.data?.available && (
          <p className="talk-video-state talk-video-fee">
            提交后会调用生成服务，供应商可能计费。
            {selectedPresenter?.voiceProvider === "bailian" && speechPrice && (
              <>
                百炼 {speechPrice.label} 配音 {speechPrice.cnyPer10k}{" "}
                元／万计费字符。配音预算仅约束合成音频。
              </>
            )}
          </p>
        )}
        {usesFal && (
          <p className="talk-video-state talk-video-fee">
            此主播使用 fal 对口型。配音需为 {falDuration}。
            {fal?.priceUsdPerSecond != null && (
              <>
                对口型每秒 US${fal.priceUsdPerSecond.toFixed(2)}
                ，按实际时长计费。
              </>
            )}
          </p>
        )}
        {error && (
          <p role="alert" className="talk-video-error">
            {error}
          </p>
        )}
      </form>
      {batch.isError && <Alert type="error" showIcon title={shortError(batch.error)} />}
      {batch.data && (
        <section className="talk-video-details talk-video-batch" aria-label="批量制作进度">
          <h3>批量制作 · {batch.data.items.length} 款</h3>
          <ul>
            {batch.data.items.map(({ productId, styleNo, job: item, message }) => (
              <li key={productId}>
                <span>{styleNo || `商品 ${productId}`}</span>
                <span>{item ? labels[item.state] : message}</span>
                {item && <Button type="text" size="small" onClick={() => openJob(item)}>查看</Button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {Boolean(batchHistory.data?.batches.length) && (
        <details className="talk-video-details talk-video-recent">
          <summary>最近批次</summary>
          {batchHistory.data?.batches.map((item) => (
            <Button key={item.id} type="text" onClick={() => openBatch(item.id)}>
              {new Date(item.createdAt).toLocaleString()} · {item.count} 款
            </Button>
          ))}
        </details>
      )}
      {job.isError && (
        <Alert
          className="talk-video-recent"
          showIcon
          type="error"
          title={shortError(job.error)}
          action={
            <Button size="small" onClick={() => void job.refetch()}>
              重试读取
            </Button>
          }
        />
      )}
      {job.isLoading && (
        <p className="talk-video-state" role="status">
          <LoadingOutlined /> 正在读取任务
        </p>
      )}
      {currentJob && (
        <VideoResult
          key={currentJob.id}
          account={account}
          job={currentJob}
          onUpdate={openJob}
        />
      )}
      {recent.length > 0 && (
        <details className="talk-video-details talk-video-recent">
          <summary>最近任务</summary>
          <ul className="talk-video-history">
            {recent.map((value) => (
              <li key={value.id}>
                <Button
                  type="link"
                  onClick={() => {
                    const queryKey = jobKey(account, value.id);
                    openJob(client.getQueryData<Job>(queryKey) || value);
                    void client.invalidateQueries({ queryKey });
                  }}
                >
                  {value.styleNo} · {value.presenterName} ·{" "}
                  {new Date(value.createdAt).toLocaleString("zh-CN", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </Button>
                <span>
                  {
                    labels[
                      currentJob?.id === value.id
                        ? currentJob.state
                        : value.state
                    ]
                  }
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {addingPresenter && options.data && (
        <PresenterDialog
          account={account}
          options={options.data}
          onClose={() => setAddingPresenter(false)}
          onRemoved={(id) =>
            client.setQueryData<Options>(
              optionsKey,
              (current) =>
                current && {
                  ...current,
                  presenters: current.presenters.filter(
                    (value) => value.id !== id,
                  ),
                },
            )
          }
          onSaved={(presenter) => {
            client.setQueryData<Options>(
              optionsKey,
              (current) =>
                current && {
                  ...current,
                  presenters: [
                    presenter,
                    ...current.presenters.filter(
                      (value) => value.id !== presenter.id,
                    ),
                  ],
                },
            );
            setPresenterId(presenter.id);
            setAddingPresenter(false);
            void client.invalidateQueries({ queryKey: optionsKey });
          }}
          onVoiceSelected={(voice) =>
            client.setQueryData<Options>(
              optionsKey,
              (current) =>
                current && {
                  ...current,
                  voices: [
                    voice,
                    ...current.voices.filter(({ id }) => id !== voice.id),
                  ],
                },
            )
          }
          onVoiceRemoved={(voiceId) => {
            client.setQueryData<Options>(
              optionsKey,
              (current) =>
                current && {
                  ...current,
                  voices: current.voices.filter(({ id }) => id !== voiceId),
                },
            );
            void client.invalidateQueries({ queryKey: optionsKey });
          }}
          onVoiceRecheck={() => void options.refetch()}
        />
      )}
    </>
  );
}

function useProduct(account: string, id?: string) {
  return useQuery<Product>({
    queryKey: ["commerce-video", account, "product", id],
    queryFn: ({ signal }) =>
      studioApi(
        `${path}/products/${encodeURIComponent(id!)}`,
        "GET",
        undefined,
        { signal },
      ),
    enabled: Boolean(id),
  });
}

function PresenterDialog({
  account,
  options,
  onClose,
  onSaved,
  onRemoved,
  onVoiceSelected,
  onVoiceRemoved,
  onVoiceRecheck,
}: {
  account: string;
  options: Options;
  onClose: () => void;
  onSaved: (presenter: Presenter) => void;
  onRemoved: (id: string) => void;
  onVoiceSelected: (voice: Voice) => void;
  onVoiceRemoved: (id: string) => void;
  onVoiceRecheck: () => void;
}) {
  const { modal } = App.useApp();
  const canUpload = Boolean(
    options.templates?.length || options.readiness?.fal,
  );
  const [name, setName] = useState("");
  const [avatarId, setAvatar] = useState(
    options.avatars.length === 1 ? options.avatars[0]?.id : undefined,
  );
  const [voiceId, setVoice] = useState<string | undefined>(
    options.voices.find((voice) => voice.kind === "default")?.id ||
      options.voices[0]?.id,
  );
  const [newPortrait, setNewPortrait] = useState(
    !options.avatars.length && canUpload,
  );
  const [templateId, setTemplate] = useState(options.templates?.[0]?.id);
  const [portrait, setPortrait] = useState<File>();
  const [createdAvatar, setCreatedAvatar] = useState<Avatar>();
  const [authorized, setAuthorized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showBailian, setShowBailian] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const upload = useRef<{
    file: File;
    name: string;
    templateId?: string;
    id: string;
  } | null>(null);
  const avatars = [
    ...(createdAvatar &&
    !options.avatars.some((item) => item.id === createdAvatar.id)
      ? [createdAvatar]
      : []),
    ...options.avatars,
  ];
  const falUpload = Boolean(options.readiness?.fal && !templateId);
  const falPortrait = newPortrait
    ? falUpload
    : avatars.find((item) => item.id === avatarId)?.engine === "fal";
  const compatibleVoices = options.voices.filter(
    (voice) => !falPortrait || voice.kind === "cloned",
  );
  const activeVoiceId = compatibleVoices.some((voice) => voice.id === voiceId)
    ? voiceId
    : undefined;
  const canSave = Boolean(
    name.trim() &&
    activeVoiceId &&
    authorized &&
    (newPortrait ? portrait && (templateId || falUpload) : avatarId),
  );

  async function save() {
    if (!canSave || saving || voiceBusy) return;
    setSaving(true);
    setFailure("");
    try {
      let selectedAvatar = avatarId;
      if (newPortrait && portrait && (templateId || falUpload)) {
        const nameForAvatar = name.trim();
        if (
          upload.current?.file !== portrait ||
          upload.current?.name !== nameForAvatar ||
          upload.current?.templateId !== templateId
        ) {
          upload.current = {
            file: portrait,
            templateId,
            name: nameForAvatar,
            id: crypto.randomUUID(),
          };
        }
        const form = new FormData();
        form.set("file", portrait);
        form.set("name", nameForAvatar);
        if (templateId) form.set("templateId", templateId);
        form.set("requestId", upload.current.id);
        form.set("authorized", "true");
        const result: { avatar: Avatar | null; message?: string } =
          await studioApi(`${path}/presenters/portrait`, "POST", form);
        if (!result.avatar)
          throw new Error(result.message || "形象尚未创建，请先核实任务进度。");
        setCreatedAvatar(result.avatar);
        setNewPortrait(false);
        setAvatar(result.avatar.id);
        selectedAvatar = result.avatar.id;
      }
      onSaved(
        await studioApi(`${path}/presenters`, "POST", {
          name: name.trim(),
          avatarId: selectedAvatar,
          voiceId: activeVoiceId,
          authorized,
        }),
      );
    } catch (error) {
      setFailure(shortError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      title={options.presenters.length ? "管理主播" : "设置主播"}
      onCancel={onClose}
      mask={{ closable: !saving && !voiceBusy }}
      closable={!saving && !voiceBusy}
      keyboard={!saving && !voiceBusy}
      okText="保存主播"
      onOk={() => void save()}
      confirmLoading={saving}
      okButtonProps={{ disabled: !canSave || voiceBusy }}
      cancelButtonProps={{ disabled: saving || voiceBusy }}
    >
      <div className="talk-video-modal-fields">
        {options.presenters.length > 0 && (
          <details className="talk-video-roster">
            <summary>已保存的主播 · {options.presenters.length}</summary>
            <ul className="talk-video-history">
              {options.presenters.map((presenter) => (
                <li key={presenter.id}>
                  <span>{presenter.name}</span>
                  <Button
                    size="small"
                    type="text"
                    danger
                    disabled={saving}
                    onClick={() => {
                      modal.confirm({
                        title: `撤销「${presenter.name}」的主播授权？`,
                        content:
                          "撤销后，新的口播任务无法使用此主播。已有视频仍可下载。",
                        okText: "撤销授权",
                        okButtonProps: { danger: true },
                        async onOk() {
                          setFailure("");
                          try {
                            await studioApi(
                              `${path}/presenters/${encodeURIComponent(presenter.id)}`,
                              "DELETE",
                            );
                            onRemoved(presenter.id);
                          } catch (error) {
                            setFailure(shortError(error));
                          }
                        },
                      });
                    }}
                  >
                    撤销授权
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        )}
        <Input
          aria-label="主播名称"
          placeholder="主播名称"
          value={name}
          maxLength={48}
          onChange={(event) => setName(event.target.value)}
          disabled={saving}
        />
        {newPortrait ? (
          <>
            <label className="talk-video-file">
              主播照片
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={saving}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  setFailure("");
                  setAuthorized(false);
                  if (file && file.size > 10 * 1024 * 1024) {
                    setFailure("形象照须小于 10 MB。");
                    event.target.value = "";
                    setPortrait(undefined);
                  } else {
                    setPortrait(file);
                  }
                }}
              />
            </label>
            {falUpload && (
              <p className="talk-video-voice-note">
                请上传单人正面照，宽高至少 256 像素，文件最大 10 MB。
              </p>
            )}
            {options.templates.length > 1 && (
              <Select
                aria-label="形象模板"
                value={templateId}
                onChange={setTemplate}
                disabled={saving}
                options={options.templates.map(({ id, name }) => ({
                  value: id,
                  label: name,
                }))}
              />
            )}
          </>
        ) : (
          <Select
            aria-label="形象"
            value={avatarId}
            placeholder="选择已授权主播照片或形象"
            onChange={(value) => {
              setAvatar(value);
              setAuthorized(false);
            }}
            disabled={saving}
            options={avatars.map(({ id, name }) => ({
              value: id,
              label: name,
            }))}
          />
        )}
        {canUpload && (newPortrait ? avatars.length > 0 : true) && (
          <Button
            type="link"
            size="small"
            onClick={() => {
              setNewPortrait(!newPortrait);
              setAuthorized(false);
            }}
            disabled={saving}
          >
            {newPortrait ? "选择已有主播照片或形象" : "上传主播照片"}
          </Button>
        )}
        <Select
          aria-label="音色"
          value={activeVoiceId}
          placeholder="选择音色"
          onChange={setVoice}
          disabled={saving || voiceBusy}
          options={compatibleVoices.map(
            ({ id, name, kind, provider, model }) => ({
              value: id,
              label:
                provider === "bailian"
                  ? `${name}（百炼 · ${bailianVoiceModelLabel(model) || "复刻音色"}）`
                  : kind === "cloned"
                    ? `${name}（已克隆）`
                    : name,
            }),
          )}
        />
        {options.bailian && (
          <div className="talk-video-voice-section">
            <Button
              type="default"
              size="small"
              aria-expanded={showBailian}
              disabled={saving || voiceBusy}
              onClick={() => setShowBailian(!showBailian)}
            >
              {showBailian ? "收起百炼音色" : "百炼音色复刻"}
            </Button>
            {showBailian && (
              <CommerceBailianVoice
                account={account}
                catalog={options.bailian}
                disabled={saving}
                onBusy={setVoiceBusy}
                onRecheck={onVoiceRecheck}
                onSelect={(voice) => {
                  const id = `bailian:${voice.id}`;
                  onVoiceSelected({
                    id,
                    name: voice.name,
                    kind: "cloned",
                    provider: "bailian",
                    model: voice.model,
                  });
                  setVoice(id);
                  setShowBailian(false);
                }}
                onRemoved={(id) => {
                  const catalogId = `bailian:${id}`;
                  if (voiceId === catalogId) setVoice(undefined);
                  onVoiceRemoved(catalogId);
                }}
              />
            )}
          </div>
        )}
        {options.canClone &&
          !options.voices.some((voice) => voice.kind === "cloned") && (
            <Link to="/settings/ai">前往 AI 模型管理创建克隆音色</Link>
          )}
        <Checkbox
          checked={authorized}
          onChange={(event) => setAuthorized(event.target.checked)}
          disabled={saving}
        >
          {falPortrait
            ? "我已取得肖像和声音的使用授权，同意生成视频时将主播照片与口播音频交给 fal 对口型。"
            : "我已取得肖像和声音的使用授权，可用于服装带货视频。"}
        </Checkbox>
        {failure && <Alert type="error" showIcon title={failure} />}
      </div>
    </Modal>
  );
}

function VideoResult({
  account,
  job,
  onUpdate,
}: {
  account: string;
  job: Job;
  onUpdate: (job: Job) => void;
}) {
  const [edit, setEdit] = useState<{
    index: number;
    imageId: string | null;
    id: string;
  }>();
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  const product = useProduct(account, edit ? job.productId : undefined);

  async function redoScene() {
    if (!edit || saving) return;
    setFailure("");
    setSaving(true);
    try {
      const updated: Job = await studioApi(
        `${path}/jobs/${encodeURIComponent(job.id)}/scenes/${edit.index}`,
        "PATCH",
        {
          requestId: edit.id,
          imageId: edit.imageId,
        },
      );
      onUpdate(updated);
      setEdit(undefined);
    } catch (error) {
      setFailure(shortError(error));
    } finally {
      setSaving(false);
    }
  }

  const active = isActive(job.state);
  return (
    <section className="talk-video-result" aria-label="视频任务">
      <div className="talk-video-result-heading">
        <h2>
          {job.styleNo} · {job.presenterName}
        </h2>
        <div className="talk-video-result-actions">
          {job.state !== "completed" && (
            <Tag
              color={
                job.state === "failed"
                  ? "error"
                  : job.state === "uncertain"
                    ? "warning"
                    : "processing"
              }
            >
              {active && <LoadingOutlined />} {labels[job.state]}
            </Tag>
          )}
          {job.downloadUrl && (
            <Button href={job.downloadUrl} icon={<DownloadOutlined />}>
              {job.state === "completed" ? "下载 MP4" : "下载上一版"}
            </Button>
          )}
        </div>
      </div>
      {job.message && (
        <p className="talk-video-state" role="status">
          {job.message}
        </p>
      )}
      {active && !job.message && (
        <p className="talk-video-state" role="status">
          可以离开页面，制作将在后台继续。
        </p>
      )}
      {job.videoUrl && (
        <div className="talk-video-player">
          <video
            key={job.videoUrl}
            aria-label="服装口播成片"
            controls
            playsInline
            preload="metadata"
            src={job.videoUrl}
          />
        </div>
      )}
      {job.scenes.length > 0 && (
        <details className="talk-video-details">
          <summary>脚本与分镜 · {job.scenes.length} 镜</summary>
          <ol className="talk-video-shots">
            {job.scenes.map((scene, index) => (
              <li className="talk-video-shot" key={index}>
                {scene.imageUrl && (
                  <img src={scene.imageUrl} alt="商品画面" loading="lazy" />
                )}
                <strong>第 {index + 1} 镜</strong>
                {scene.start != null && scene.end != null && (
                  <small>
                    {" "}
                    · {Number(scene.start.toFixed(1))}–
                    {Number(scene.end.toFixed(1))} 秒
                  </small>
                )}
                <p>{scene.caption}</p>
                {(job.editable ?? job.state === "completed") && (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => {
                      setFailure("");
                      setEdit({
                        index,
                        imageId: scene.imageId || null,
                        id: crypto.randomUUID(),
                      });
                    }}
                  >
                    换画面
                  </Button>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
      {edit && (
        <Modal
          open
          title={`更换第 ${edit.index + 1} 镜画面`}
          onCancel={() => setEdit(undefined)}
          onOk={() => void redoScene()}
          okText="重新剪辑"
          confirmLoading={saving}
          closable={!saving}
          mask={{ closable: !saving }}
          cancelButtonProps={{ disabled: saving }}
          okButtonProps={{
            disabled:
              !product.data ||
              edit.imageId === (job.scenes[edit.index]?.imageId || null),
          }}
        >
          <div className="talk-video-modal-fields">
            <Select
              aria-label="替换画面"
              value={edit.imageId || ""}
              loading={product.isLoading}
              disabled={saving}
              onChange={(imageId) =>
                setEdit({
                  ...edit,
                  imageId: imageId || null,
                  id: crypto.randomUUID(),
                })
              }
              options={[
                { value: "", label: "主播画面" },
                ...(product.data?.images || []).map((photo, index) => ({
                  value: photo.id,
                  label: (
                    <span className="talk-video-replace-option">
                      <img src={photo.url} alt="" loading="lazy" />
                      商品图 {index + 1}
                      {photo.color ? ` · ${photo.color}` : ""}
                    </span>
                  ),
                })),
              ]}
            />
            <span className="aigc-muted">沿用本条视频的配音和字幕。</span>
            {(failure || product.isError) && (
              <Alert
                type="error"
                showIcon
                title={failure || shortError(product.error)}
              />
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
