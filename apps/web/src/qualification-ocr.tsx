import { useEffect, useRef, useState } from "react";
import { Button, Form, Space, Typography } from "antd";
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
  fields?: CertificateFields;
};
const kinds = ["idFront", "license"] as const;
const labels = { idFront: "身份证正面", license: "营业执照" };
export function useQualificationOcr(form: FormInstance, readonly: boolean) {
  const readonlyRef = useRef(readonly);
  readonlyRef.current = readonly;
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
  const jobs = useRef<
    Partial<
      Record<CertificateKind, { fileId: string; controller: AbortController }>
    >
  >({});
  const originals = useRef(new Map<string, File>());
  const filled = useRef<Partial<Record<CertificateField, string>>>({});
  const [attempt, retry] = useState(0),
    [requested, request] = useState(false);
  const onUploaded = async (file: File, fileId: string) => {
    originals.current.set(fileId, file);
  };
  useEffect(
    () => () => {
      for (const j of Object.values(jobs.current)) j?.controller.abort();
      jobs.current = {};
    },
    [],
  );
  useEffect(() => {
    if (readonly && !requested) return;
    for (const kind of kinds) {
      const fileId = kind === "idFront" ? idFront : license;
      if (jobs.current[kind]?.fileId === fileId) continue;
      jobs.current[kind]?.controller.abort();
      if (!fileId) {
        delete jobs.current[kind];
        continue;
      }
      const controller = new AbortController();
      jobs.current[kind] = { fileId, controller };
      const update = (check: Check) => {
        if (!controller.signal.aborted)
          setChecks((s) => ({ ...s, [kind]: check }));
      };
      update({ fileId, phase: "running" });
      void (async () => {
        try {
          let file: Blob | undefined = originals.current.get(fileId);
          if (!file) {
            const r = await fetch(`/api/v1/supply/files/${fileId}/content`, {
              credentials: "same-origin",
              signal: controller.signal,
            });
            if (!r.ok || !r.headers.get("content-type")?.startsWith("image/"))
              throw Error("图片读取失败");
            file = await r.blob();
          }
          const { recognizeCertificate } = await import("./certificate-ocr");
          const apply = (fields: CertificateFields) => {
            if (controller.signal.aborted) return;
            if (!readonlyRef.current)
              for (const key of expectedFields[kind]) {
                const candidates = fields[key];
                const current = String(form.getFieldValue(key) || "").trim();
                if (candidates?.length === 1 && !current) {
                  form.setFieldValue(key, candidates[0]);
                  filled.current[key] = candidates[0];
                }
                // If a later pass disagrees, undo only our own untouched auto-fill.
                else if (
                  (candidates?.length || 0) > 1 &&
                  filled.current[key] === current
                ) {
                  form.setFieldValue(key, undefined);
                  delete filled.current[key];
                }
              }
          };
          const fields = await recognizeCertificate(
            file,
            kind,
            () => {},
            controller.signal,
            apply,
          );
          apply(fields);
          update({ fileId, phase: "done", fields });
        } catch {
          update({ fileId, phase: "error" });
        } finally {
          originals.current.delete(fileId);
        }
      })();
    }
  }, [idFront, license, readonly, requested, attempt, form]);
  const entries = kinds.flatMap((kind) => {
    const check = checks[kind];
    return check && check.fileId === (kind === "idFront" ? idFront : license)
      ? [{ kind, check }]
      : [];
  });
  const busy = entries.some((e) => e.check.phase === "running");
  const warning = (field: string) =>
    entries
      .filter(
        ({ check }) =>
          check.phase === "done" &&
          certificateDifferences(check.fields || {}, values).includes(
            field as CertificateField,
          ),
      )
      .map(({ kind }) => `与${labels[kind]}识别结果不一致，请核对`)
      .join("；");
  const rerun = () => {
    for (const j of Object.values(jobs.current)) j?.controller.abort();
    jobs.current = {};
    request(true);
    retry((n) => n + 1);
  };
  const issues = entries.filter(
    ({ check, kind }) =>
      check.phase === "error" ||
      (check.phase === "done" &&
        (expectedFields[kind].some(
          (f) => (check.fields?.[f]?.length || 0) !== 1,
        ) ||
          certificateDifferences(check.fields || {}, values).length > 0)),
  );
  const panel = (
    <div className="qualification-ocr-panel">
      {issues.map(({ kind, check }) => (
        <div key={kind} style={{ fontSize: 12, marginTop: 4 }}>
          {check.phase === "error" ? (
            <Typography.Text type="warning">
              {labels[kind]}未可靠识别，请核对图片或手动填写。
            </Typography.Text>
          ) : (
            <>
              {expectedFields[kind].map((field) => {
                const candidates = check.fields?.[field] || [];
                const mismatch = certificateDifferences(
                  check.fields || {},
                  values,
                ).includes(field);
                if (candidates.length === 1 && !mismatch) return null;
                return (
                  <Space key={field} size={4} wrap>
                    <Typography.Text type="warning">
                      {labels[kind]} · {certificateLabels[field]}
                      {!candidates.length
                        ? "未可靠识别"
                        : candidates.length > 1
                          ? "存在多个识别结果"
                          : "与照片不一致"}
                      ，请核对。
                    </Typography.Text>
                    {mismatch && candidates.length === 1 && !readonly && (
                      <Button
                        size="small"
                        type="link"
                        onClick={() => form.setFieldValue(field, candidates[0])}
                      >
                        采用照片内容：{candidates[0]}
                      </Button>
                    )}
                  </Space>
                );
              })}
            </>
          )}
        </div>
      ))}
      {(readonly || issues.length > 0) && (
        <Button
          size="small"
          type="link"
          disabled={busy || (!idFront && !license)}
          onClick={rerun}
        >
          {readonly ? "核对证件" : "重新识别"}
        </Button>
      )}
    </div>
  );
  return { onUploaded, warning, panel, busy };
}
