import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Collapse, Select, Space, Table, Tag } from "antd";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import { useSelectionWorkspace } from "./selection-workspace";
import { loadJushuitanMappings, loadJushuitanSources } from "./jushuitan-data";
import {
  buildJushuitanProducts, defaultJushuitanSupplierColor, jushuitanGarmentKind, jushuitanHeaders,
  type JushuitanOverride, type JushuitanOverrides, type JushuitanResult, type JushuitanSource,
} from "./jushuitan-products";
import { downloadJushuitanWorkbook } from "./jushuitan-workbook";

export function JushuitanTool({ getSelectedIds }: { getSelectedIds: () => Promise<string[]> }) {
  const { api, archiveReferences } = useSelectionWorkspace();
  const { message } = App.useApp();
  const selected = useRef(getSelectedIds);
  selected.current = getSelectedIds;
  const active = useRef(true), lock = useRef(false);
  const [ids, setIds] = useState<string[]>([]);
  const [sources, setSources] = useState<JushuitanSource[]>([]);
  const [overrides, setOverrides] = useState<JushuitanOverrides>({});
  const [result, setResult] = useState<JushuitanResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const run = async (label: string, work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(label); setError("");
    try { await work(); }
    catch (e) { if (active.current) { setError((e as Error).message); setResult(null); } }
    finally { lock.current = false; if (active.current) setBusy(""); }
  };
  const read = () => run("正在读取选中款号…", async () => {
    setResult(null); setSources([]); setIds([]); setOverrides({});
    const nextIds = await selected.current();
    const fresh = await loadJushuitanSources(nextIds, api, archiveReferences);
    if (active.current) { setIds(nextIds); setSources(fresh); }
  });
  useEffect(() => {
    active.current = true;
    void read();
    return () => { active.current = false; };
  }, []);
  const calculate = async () => {
    const [fresh, mappings] = await Promise.all([loadJushuitanSources(ids, api, archiveReferences), loadJushuitanMappings()]);
    const generated = buildJushuitanProducts(fresh, mappings, overrides);
    if (active.current) setSources(fresh);
    return generated;
  };
  const generate = () => run("正在生成建档资料…", async () => {
    const generated = await calculate();
    if (active.current) setResult(generated);
  });
  const download = () => run("正在核验并导出…", async () => {
    if (!result || result.issues.some(issue => issue.severity === "error")) return;
    const verified = await calculate();
    if (JSON.stringify(verified) !== JSON.stringify(result)) {
      throw Error("表格资料、查看权限或颜色尺码映射已变化，请核对后重新生成");
    }
    if (!active.current) return;
    await downloadJushuitanWorkbook(verified.rows);
    if (active.current) message.success(`已导出 ${verified.styleCount} 款、${verified.rows.length} 条商品资料`);
  });
  const update = (id: string, value: JushuitanOverride) => {
    setOverrides(current => ({ ...current, [id]: { ...current[id], ...value } }));
    setResult(null); setError("");
  };
  const issues = result?.issues || sources.flatMap(source => source.issues);
  const errors = issues.filter(issue => issue.severity === "error");
  const warnings = issues.filter(issue => issue.severity === "warning");
  const preview = result && !errors.length ? result.rows : [];
  return <div className="jushuitan-tool">
    <p className="jushuitan-intro">按标准颜色 × 尺码展开商品，生成与建档模板一致的 38 列资料。先核对颜色对应及号型，再生成并下载 Excel。</p>
    <Space wrap>
      <Tag>{sources.length ? `已选 ${sources.length} 款` : "尚未读取款号"}</Tag>
      <Button aria-label="重新读取选中款号" icon={<ReloadOutlined aria-hidden />} disabled={!!busy} onClick={() => void read()}>重新读取选中款号</Button>
      <Button type="primary" disabled={!sources.length || !!busy} onClick={() => void generate()}>生成建档资料</Button>
      <Button aria-label="下载 Excel" icon={<DownloadOutlined aria-hidden />} disabled={!preview.length || !!busy} onClick={() => void download()}>下载 Excel</Button>
    </Space>
    {busy && <div role="status" className="jushuitan-status">{busy}</div>}
    {error && <Alert type="error" showIcon title={error} />}
    {!!sources.length && <Collapse defaultActiveKey={["options"]} items={[{
      key: "options", label: "颜色对应与号型规则",
      children: <>
        <p className="jushuitan-note">两列颜色数量相同时按现有顺序对应，可在此调整；调整仅用于本次文件。</p>
        <div className="jushuitan-options">
          {sources.map(source => <section className="jushuitan-style" key={source.id}>
            <div className="jushuitan-style-title">
              <strong>{source.values.style || `所选记录 ${source.id}`}</strong>
              <span>{source.values.category || "未填写三级类目"}</span>
              <Select
                aria-label={`${source.values.style || source.id}号型规则`}
                placeholder="选择号型规则" disabled={!!busy}
                value={overrides[source.id]?.kind || jushuitanGarmentKind(source.values.category)}
                options={[{ value: "upper", label: "上装（含连衣裙）" }, { value: "lower", label: "下装（裙 / 裤）" }]}
                onChange={kind => update(source.id, { kind })}
              />
            </div>
            <div className="jushuitan-colors">
              {source.colors.map(color => <label key={color}>
                <span>{color} →</span>
                <Select aria-label={`${source.values.style || source.id} ${color}供应商颜色`} disabled={!!busy || !source.supplierColors.length}
                  placeholder={source.supplierColors.length ? "选择供应商颜色" : "供应商颜色留空"}
                  value={(overrides[source.id]?.supplierColors?.[color] ?? defaultJushuitanSupplierColor(source, color)) || undefined}
                  options={source.supplierColors.map(value => ({ value, label: value }))}
                  onChange={value => update(source.id, { supplierColors: { ...overrides[source.id]?.supplierColors, [color]: value } })}
                />
              </label>)}
            </div>
          </section>)}
        </div>
      </>,
    }]} />}
    {!!errors.length && <Alert type="error" showIcon title={`有 ${errors.length} 项需要处理，暂不能导出`} description={
      <ul className="jushuitan-issues">{errors.map((issue, index) => <li key={index}>{issue.style}：{issue.message}</li>)}</ul>
    } />}
    {!!warnings.length && <Collapse items={[{
      key: "warnings", label: `${warnings.length} 项字段留空提示（可展开核对）`,
      children: <ul className="jushuitan-issues">{warnings.map((issue, index) => <li key={index}>{issue.style}：{issue.message}</li>)}</ul>,
    }]} />}
    {!!preview.length && <>
      <strong className="jushuitan-result" role="status">已生成 {result!.styleCount} 款、{preview.length} 条商品资料</strong>
      <Table
        size="small" bordered rowKey="key" dataSource={preview.map((values, index) => ({ key: index, values }))}
        columns={jushuitanHeaders.map((header, index) => ({
          title: header, key: String(index), width: [2, 35].includes(index) ? 300 : index === 1 ? 260 : 170,
          fixed: index < 2 ? "left" as const : undefined,
          render: (_: unknown, row: { values: (string | number)[] }) => <span className="jushuitan-value">{row.values[index] === "" ? "—" : row.values[index]}</span>,
        }))}
        scroll={{ x: 7040, y: 420 }} pagination={{ pageSize: 20, showSizeChanger: false, showTotal: total => `共 ${total} 条` }}
      />
    </>}
    <p className="jushuitan-note">下载文件用于聚水潭导入；当前表格及库存不会改动。图片、国标码等模板未指定取值的列保留为空。</p>
  </div>;
}
