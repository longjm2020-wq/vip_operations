import { CopyableCode, productCodeLabel } from "./copyable-code";
import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Collapse, Select, Space, Table, Tag } from "antd";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import { useSelectionWorkspace } from "./selection-workspace";
import { loadRegistrationMappings } from "./product-registration-data";
import { loadVipRegistrationSources } from "./vip-registration-data";
import { buildVipRegistration, vipRegistrationHeaders, type VipRegistrationOverrides, type VipRegistrationSource } from "./vip-product-registration";
import { defaultRegistrationSupplierColor, type RegistrationResult } from "./product-registration-sources";
import { downloadVipRegistrationFile } from "./vip-registration-workbook";

export function VipRegistrationTool({ getSelectedIds }: { getSelectedIds: () => Promise<string[]> }) {
  const { api, archiveReferences } = useSelectionWorkspace();
  const { message } = App.useApp();
  const selected = useRef(getSelectedIds);
  selected.current = getSelectedIds;
  const active = useRef(true), lock = useRef(false);
  const [ids, setIds] = useState<string[]>([]);
  const [sources, setSources] = useState<VipRegistrationSource[]>([]);
  const [overrides, setOverrides] = useState<VipRegistrationOverrides>({});
  const [result, setResult] = useState<RegistrationResult | null>(null);
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
    const fresh = await loadVipRegistrationSources(nextIds, api, archiveReferences);
    if (active.current) { setIds(nextIds); setSources(fresh); }
  });
  useEffect(() => {
    active.current = true;
    void read();
    return () => { active.current = false; };
  }, []);
  const calculate = async () => {
    const [fresh, mappings] = await Promise.all([loadVipRegistrationSources(ids, api, archiveReferences), loadRegistrationMappings()]);
    const generated = buildVipRegistration(fresh, mappings, overrides);
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
    await downloadVipRegistrationFile(verified.rows);
    if (active.current) message.success(`已导出 ${verified.styleCount} 款、${verified.rows.length} 条唯品会商品资料`);
  });
  const issues = result?.issues || sources.flatMap(source => source.issues);
  const errors = issues.filter(issue => issue.severity === "error"), warnings = issues.filter(issue => issue.severity === "warning");
  const preview = result && !errors.length ? result.rows : [];
  return <div className="jushuitan-tool vip-registration-tool">
    <p className="jushuitan-intro">按标准颜色 × 尺码生成货号和条形码，保留唯品会模板的 29 列。核对供应商颜色后生成预览，下载 .xls 建档资料。</p>
    <Space wrap>
      <Tag>{sources.length ? `已选 ${sources.length} 款` : "尚未读取款号"}</Tag>
      <Button aria-label="重新读取选中款号" icon={<ReloadOutlined aria-hidden />} disabled={!!busy} onClick={() => void read()}>重新读取选中款号</Button>
      <Button type="primary" disabled={!sources.length || !!busy} onClick={() => void generate()}>生成建档资料</Button>
      <Button aria-label="下载 Excel" icon={<DownloadOutlined aria-hidden />} disabled={!preview.length || !!busy} onClick={() => void download()}>下载 Excel</Button>
    </Space>
    {busy && <div role="status" className="jushuitan-status">{busy}</div>}
    {error && <Alert type="error" showIcon title={error} />}
    {!!sources.length && <Collapse defaultActiveKey={["colors"]} items={[{
      key: "colors", label: "颜色对应",
      children: <>
        <p className="jushuitan-note">标准颜色用于查找色码，供应商颜色填入模板的「自定义颜色」。两列数量相同时按现有顺序对应，可在此调整。</p>
        <div className="jushuitan-options">
          {sources.map(source => <section className="jushuitan-style" key={source.id}>
            <div className="jushuitan-style-title"><strong>{source.values.style || `所选记录 ${source.id}`}</strong><span>{source.values.category || "未填写三级类目"}</span></div>
            <div className="jushuitan-colors">
              {source.colors.map(color => <label key={color}><span>{color} →</span>
                <Select aria-label={`${source.values.style || source.id} ${color}供应商颜色`} disabled={!!busy || !source.supplierColors.length}
                  placeholder={source.supplierColors.length ? "选择供应商颜色" : "供应商颜色留空"}
                  value={(overrides[source.id]?.supplierColors?.[color] ?? defaultRegistrationSupplierColor(source, color)) || undefined}
                  options={source.supplierColors.map(value => ({ value, label: value }))}
                  onChange={value => {
                    setOverrides(current => ({ ...current, [source.id]: { supplierColors: { ...current[source.id]?.supplierColors, [color]: value } } }));
                    setResult(null); setError("");
                  }}
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
      <Table size="small" bordered rowKey="key" dataSource={preview.map((values, index) => ({ key: index, values }))}
        columns={vipRegistrationHeaders.map((header, index) => ({
          title: header, key: String(index), width: index === 4 ? 320 : index === 3 ? 250 : [1, 2].includes(index) ? 210 : 150,
          fixed: index === 1 ? "left" as const : undefined,
          render: (_: unknown, row: { values: (string | number)[] }) => <span className="jushuitan-value">{productCodeLabel(header) ? <CopyableCode value={row.values[index]} label={header} /> : row.values[index] === "" ? "—" : row.values[index]}</span>,
        }))}
        scroll={{ x: 4740, y: 420 }} pagination={{ pageSize: 20, showSizeChanger: false, showTotal: total => `共 ${total} 条` }}
      />
    </>}
    <p className="jushuitan-note">品牌默认「序缇」，商品类别默认「普通商品」，市场价取「吊牌价」。副标题、标准尺码、标准颜色等模板未指定取值的列留空。生成和下载只产生文件，导入唯品会需在平台完成。</p>
  </div>;
}
