import { Bar, Button, BusyIndicator, Input, Label, MessageStrip, Option, Panel, Select, Text, Title } from "@ui5/webcomponents-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";

// Step 1 of the wizard: enter a single object to run through discovery ->
// analysis -> fix review -> results, without needing to build an Excel
// file for one program. Bulk upload (many programs at once) stays on the
// existing Upload page — this is specifically for the one-at-a-time case.
export function NewProgramPage() {
  const [programName, setProgramName] = useState("");
  const [pkg, setPkg] = useState("");
  const [businessArea, setBusinessArea] = useState("");
  const [criticality, setCriticality] = useState<"H" | "M" | "L">("M");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function handleCreate() {
    if (!programName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const program = await api.createProgram({ programName: programName.trim(), package: pkg, businessArea, criticality, owner });
      navigate(`/programs/${program.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: "2rem auto", padding: "0 1rem" }}>
      <Title level="H2" style={{ marginBottom: "1rem" }}>
        Step 1 of 4 — Enter the object
      </Title>
      <Panel headerText="Object details">
        <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <Text>
            For bulk intake of many programs at once, use the{" "}
            <a href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>
              Excel upload
            </a>{" "}
            instead. This form runs the same discovery + analysis pipeline for a single object.
          </Text>
          {error && <MessageStrip design="Negative">{error}</MessageStrip>}
          <Label required>Program name</Label>
          <Input value={programName} onInput={(e) => setProgramName(e.target.value)} placeholder="e.g. ZTEST_VK2" />
          <Label>Package</Label>
          <Input value={pkg} onInput={(e) => setPkg(e.target.value)} placeholder="e.g. ZCC" />
          <Label>Business process area</Label>
          <Input value={businessArea} onInput={(e) => setBusinessArea(e.target.value)} placeholder="e.g. Materials" />
          <Label>Business criticality</Label>
          <Select onChange={(e) => setCriticality((e.detail.selectedOption?.value as "H" | "M" | "L") ?? "M")}>
            <Option value="H" selected={criticality === "H"}>High</Option>
            <Option value="M" selected={criticality === "M"}>Medium</Option>
            <Option value="L" selected={criticality === "L"}>Low</Option>
          </Select>
          <Label>Owner</Label>
          <Input value={owner} onInput={(e) => setOwner(e.target.value)} placeholder="e.g. your name" />
          <BusyIndicator active={busy}>
            <Bar
              endContent={
                <Button design="Emphasized" disabled={!programName.trim() || busy} onClick={handleCreate}>
                  Next: discover &amp; analyze →
                </Button>
              }
            />
          </BusyIndicator>
        </div>
      </Panel>
    </div>
  );
}
