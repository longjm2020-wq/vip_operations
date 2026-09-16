import { useEffect, useRef, useState } from "react";
import { Alert, Button, Form, Space } from "antd";
import type { FormInstance } from "antd";
import {
  certificateLabels,
  expectedFields,
  certificateDifferences,
  type CertificateKind,
  type CertificateFields,
  type CertificateField,
} from "../../../packages/contracts/src/certificate-fields";

type Check = {
  fileId: string;
  phase: "running" | "done" | "error";
  message?: string;
  fields?: CertificateFields;
};
const sourceLabels = { idFront: "身份证正面", license: "营业执照" };
export function useQualificationOcr(form: FormInstance, readonly: boolean) {
  const idFront = Form.useWatch("idFront", { form, preserve: true }) as
    string | undefined;
  const license = Form.useWatch("license", { form, preserve: true }) as
    string | undefined;
  const values =
    Form.useWatch(
      (v) => ({
        legalId: v.legalId,
        legalName: v.legalName,
        company: v.company,
        creditCode: v.creditCode,
      }),
      form,
    ) || {};
  const [checks, setChecks] = useState<Partial<Record<CertificateKind, Check>>>(
    {},
  );
  const completed = useRef<Partial<Record<CertificateKind, Check>>>({});
  const originals = useRef(new Map<string, File>());
  const [attempt, retry] = useState(0);
  const [requested, request] = useState(false);
  const onUploaded = async (file: File, fileId: string) => {
    originals.current.set(fileId, file);
  };
  useEffect(() => {
    if (readonly && !requested) return;
    const controller = new AbortController();
    const files = { idFront, license };
    const update = (kind: CertificateKind, check: Check) => {
      if (!controller.signal.aborted) {
        completed.current[kind] = check;
        setChecks((s) => ({ ...s, [kind]: check }));
      }
    };
    void (async () => {
      for (const kind of ["idFront", "license"] as const) {
        const fileId = files[kind];
        if (!fileId || controller.signal.aborted) continue;
        const previous = completed.current[kind];
        if (previous?.fileId === fileId && previous.phase !== "running")
          continue;
        update(kind, { fileId, phase: "running", message: "正在读取证件…" });
        try {
          let file: Blob | undefined = originals.current.get(fileId);
          if (!file) {
            const response = await fetch(
              `/api/v1/supply/files/${fileId}/content`,
              { credentials: "same-origin", signal: controller.signal },
            );
            if (
              !response.ok ||
              !response.headers.get("content-type")?.startsWith("image/")
            )
              throw Error("读取证件失败，请刷新登录状态后重试");
            file = await response.blob();
          }
          const { recognizeCertificate } = await import("./certificate-ocr");
          if (controller.signal.aborted) break;
          const fields = await recognizeCertificate(
            file,
            kind,
            (message) => update(kind, { fileId, phase: "running", message }),
            controller.signal,
          );
          if (controller.signal.aborted) break;
          if (!readonly) {
            for (const key of expectedFields[kind]) {
              const candidates = fields[key];
              if (
                candidates?.length === 1 &&
                !String(form.getFieldValue(key) || "").trim()
              )
                form.setFieldValue(key, candidates[0]);
            }
          }
          update(kind, { fileId, phase: "done", fields });
        } catch (e) {
          if (!controller.signal.aborted)
            update(kind, {
              fileId,
              phase: "error",
              message: (e as Error).message || "识别失败，请重试",
            });
        } finally {
          originals.current.delete(fileId);
        }
      }
    })();
    return () => controller.abort();
  }, [idFront, license, readonly, requested, attempt, form]);
  const entries = (["idFront", "license"] as const).flatMap((kind) => {
    const check = checks[kind];
    return check && check.fileId === (kind === "idFront" ? idFront : license)
      ? [{ kind, check }]
      : [];
  });
  const busy =
    (!readonly || requested) &&
    (["idFront", "license"] as const).some((kind) => {
      const fileId = kind === "idFront" ? idFront : license;
      return (
        fileId &&
        (checks[kind]?.fileId !== fileId || checks[kind]?.phase === "running")
      );
    });
  const warning = (field: string) =>
    entries
      .filter(
        ({ check }) =>
          check.phase === "done" &&
          certificateDifferences(check.fields || {}, values).includes(
            field as CertificateField,
          ),
      )
      .map(({ kind }) => `与${sourceLabels[kind]}识别结果不一致，请核对`)
      .join("；");
  const panel = (
    <div className="qualification-ocr-panel">
      <Space wrap style={{ margin: "8px 0" }}>
        <Button
          disabled={busy || (!idFront && !license)}
          loading={busy}
          onClick={() => {
            completed.current = {};
            request(true);
            retry((n) => n + 1);
          }}
        >
          {readonly ? "识别并核对证件" : "重新识别已上传证件"}
        </Button>
        <span className="secondary">
          {readonly
            ? "仅核对证件与当前资料的差异，不修改已保存内容。"
            : "自动填入空白字段；已有内容不覆盖，差异会持续提醒。"}
          识别结果需核对原件。
        </span>
      </Space>
      {entries.map(({ kind, check }) => {
        const fields = check.fields || {};
        const differences = certificateDifferences(fields, values);
        const missing = expectedFields[kind].filter((f) => !fields[f]?.length);
        const ambiguous = expectedFields[kind].filter(
          (f) => (fields[f]?.length || 0) > 1,
        );
        return (
          <Alert
            key={kind}
            showIcon
            style={{ marginBottom: 8 }}
            type={
              check.phase === "error"
                ? "error"
                : check.phase === "running"
                  ? "info"
                  : differences.length || missing.length || ambiguous.length
                    ? "warning"
                    : "success"
            }
            title={`${sourceLabels[kind]}：${check.phase === "running" ? check.message : check.phase === "error" ? check.message : "识别完成，请核对以下结果"}`}
            description={
              check.phase === "done" && (
                <>
                  {expectedFields[kind]
                    .filter((f) => fields[f]?.length)
                    .map((field) => (
                      <div key={field}>
                        <strong>{certificateLabels[field]}</strong>：
                        {fields[field]!.join(" / ")}
                        {differences.includes(field) && (
                          <span style={{ color: "#cf1322", marginLeft: 8 }}>
                            与当前填写不一致
                          </span>
                        )}
                        {fields[field]!.length > 1 && (
                          <span>（存在多个候选，需人工核对）</span>
                        )}
                        {!readonly &&
                          fields[field]!.length === 1 &&
                          (differences.includes(field) || !values[field]) && (
                            <Button
                              type="link"
                              size="small"
                              onClick={() =>
                                form.setFieldValue(field, fields[field]![0])
                              }
                            >
                              采用识别值
                            </Button>
                          )}
                      </div>
                    ))}
                  {missing.length > 0 && (
                    <p>
                      未可靠识别：
                      {missing.map((f) => certificateLabels[f]).join("、")}
                      。请重新拍摄清晰完整的证件，或人工核对填写；未识别不代表信息一致。
                    </p>
                  )}
                </>
              )
            }
          />
        );
      })}
    </div>
  );
  return { onUploaded, warning, panel, busy };
}
