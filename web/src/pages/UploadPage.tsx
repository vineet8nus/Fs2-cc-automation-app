import { Bar, BusyIndicator, Button, FileUploader, MessageStrip, Panel, Text, Title } from "@ui5/webcomponents-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";

export function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function handleUpload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api.uploadExcel(file);
      navigate("/programs");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
      <Panel headerText="Upload Clean Core intake list" style={{ marginBottom: "1rem" }}>
        <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          <Text>
            Upload an Excel file with the programs to assess. Expected columns: <b>Program Name</b>, Package, Business
            Process Area, Business Criticality (H/M/L), Notes/Owner.
          </Text>
          <FileUploader
            accept=".xlsx,.xls"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          >
            <Button>Choose Excel file</Button>
          </FileUploader>
          {file && <Text>Selected: {file.name}</Text>}
          {error && <MessageStrip design="Negative">{error}</MessageStrip>}
          <BusyIndicator active={busy}>
            <Bar
              endContent={
                <Button design="Emphasized" disabled={!file || busy} onClick={handleUpload}>
                  Upload &amp; run discovery + analysis
                </Button>
              }
            />
          </BusyIndicator>
        </div>
      </Panel>
      <Panel headerText="What happens next" collapsed>
        <div style={{ padding: "1rem" }}>
          <Text>
            Each program is automatically snapshotted to Git, its dependency tree is discovered, a central ATC
            clean-core check runs, and baseline tests are captured — all before any human review. You'll be asked to
            approve scope at Gate 1, and again after remediation + validation at Gate 2.
          </Text>
        </div>
      </Panel>
    </div>
  );
}
