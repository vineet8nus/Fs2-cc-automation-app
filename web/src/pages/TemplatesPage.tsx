import { Button, FlexBox, Label, MessageStrip, Panel, Text, Title } from "@ui5/webcomponents-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";

type TemplateInfo = { filename: string; uploadedAt: string | null };

function TemplateUploadCard({
  title,
  description,
  accept,
  info,
  onUpload,
}: {
  title: string;
  description: string;
  accept: string;
  info: TemplateInfo | null;
  onUpload: (file: File) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Panel headerText={title}>
      <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <Text>{description}</Text>
        {info && (
          <Text style={{ color: "var(--sapContent_LabelColor)" }}>
            Current: <b>{info.filename}</b>
            {info.uploadedAt ? ` — uploaded ${new Date(info.uploadedAt).toLocaleString()}` : " (bundled default, never overridden)"}
          </Text>
        )}
        {error && <MessageStrip design="Negative">{error}</MessageStrip>}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          style={{ display: "none" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            setError(null);
            try {
              await onUpload(file);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
              if (inputRef.current) inputRef.current.value = "";
            }
          }}
        />
        <FlexBox>
          <Button disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? "Uploading…" : "Upload replacement"}
          </Button>
        </FlexBox>
      </div>
    </Panel>
  );
}

export function TemplatesPage() {
  const [templates, setTemplates] = useState<Record<"tsd" | "unit_test", TemplateInfo> | null>(null);

  const load = () => api.listTemplates().then(setTemplates);
  useEffect(() => {
    load();
  }, []);

  if (!templates) return <div style={{ padding: "2rem" }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 800, margin: "2rem auto", padding: "0 1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Title level="H2">Document templates</Title>
      <Text>
        These two org-wide templates are what every program's TSD and Unit Test document are generated from, at Gate
        2 approval. Replacing one here applies to every program generated afterward — it doesn't affect documents
        already generated for earlier programs.
      </Text>
      <TemplateUploadCard
        title="TSD template (.docx)"
        description="NUS Technical Specification Document template. Must keep the {objectName}/{title}/{description}/{author}/{generatedDate}, {developmentType}/{developmentTool}/{impactedSystems}, {#objects}...{/objects}, and {#findings}...{/findings} placeholders for generation to work."
        accept=".docx"
        info={templates.tsd}
        onUpload={async (file) => {
          await api.uploadTemplate("tsd", file);
          await load();
        }}
      />
      <TemplateUploadCard
        title="Unit Test template (.xlsx)"
        description='Must keep the "Summary" sheet (cells B2-B14) and "Test Case" sheet (header row + data starting row 2) layout.'
        accept=".xlsx"
        info={templates.unit_test}
        onUpload={async (file) => {
          await api.uploadTemplate("unit_test", file);
          await load();
        }}
      />
    </div>
  );
}
