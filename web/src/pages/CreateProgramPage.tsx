import {
  Bar,
  Breadcrumbs,
  BreadcrumbsItem,
  Button,
  BusyIndicator,
  DynamicPage,
  DynamicPageTitle,
  FileUploader,
  Form,
  FormGroup,
  FormItem,
  Input,
  MessageStrip,
  Option,
  Panel,
  SegmentedButton,
  SegmentedButtonItem,
  Select,
  Text,
  Title,
} from "@ui5/webcomponents-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { OBJECT_TYPES } from "../components/objectTypes";
import { AbapObjectType } from "../types";

type Mode = "single" | "bulk";

export function CreateProgramPage() {
  const [mode, setMode] = useState<Mode>("single");
  const navigate = useNavigate();

  return (
    <DynamicPage
      headerTitle={
        <DynamicPageTitle
          breadcrumbs={
            <Breadcrumbs>
              <BreadcrumbsItem onClick={() => navigate("/")}>Programs</BreadcrumbsItem>
              <BreadcrumbsItem>Create</BreadcrumbsItem>
            </Breadcrumbs>
          }
          header={<Title level="H2">Create</Title>}
        >
          <SegmentedButton onSelectionChange={(e) => setMode(e.detail.selectedItems[0]?.getAttribute("data-mode") === "bulk" ? "bulk" : "single")}>
            <SegmentedButtonItem data-mode="single" pressed={mode === "single"}>
              Single object
            </SegmentedButtonItem>
            <SegmentedButtonItem data-mode="bulk" pressed={mode === "bulk"}>
              Bulk upload (Excel)
            </SegmentedButtonItem>
          </SegmentedButton>
        </DynamicPageTitle>
      }
    >
      {mode === "single" ? <SingleObjectForm /> : <BulkUploadForm />}
    </DynamicPage>
  );
}

function SingleObjectForm() {
  const [programName, setProgramName] = useState("");
  const [objectType, setObjectType] = useState<AbapObjectType>("PROGRAM");
  const [pkg, setPkg] = useState("");
  const [businessArea, setBusinessArea] = useState("");
  const [criticality, setCriticality] = useState<"H" | "M" | "L">("M");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const selectedType = OBJECT_TYPES.find((t) => t.value === objectType);

  async function handleCreate() {
    if (!programName.trim() || !pkg.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const program = await api.createProgram({
        programName: programName.trim(),
        objectType,
        package: pkg,
        businessArea,
        criticality,
        owner,
      });
      navigate(`/programs/${program.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 960, display: "flex", flexDirection: "column", gap: "1rem" }}>
      {error && <MessageStrip design="Negative">{error}</MessageStrip>}
      {selectedType && !selectedType.supported && (
        <MessageStrip design="Warning">
          {selectedType.label} objects aren't read from or written to the live system yet — only Programs/Includes
          are today. This entry will be captured and parked for tracking, without touching SAP.
        </MessageStrip>
      )}
      <Panel headerText="Object details">
        <Form
          titleText="Selection"
          columnsS={1}
          columnsM={2}
          columnsL={2}
          columnsXL={2}
          labelSpanM={5}
          labelSpanL={5}
          labelSpanXL={5}
          style={{ padding: "0.5rem 1rem" }}
        >
          <FormGroup titleText="Identification">
            <FormItem label="Program name *">
              <Input value={programName} onInput={(e) => setProgramName(e.target.value)} placeholder="e.g. ZTEST_VK2" />
            </FormItem>
            <FormItem label="Object type">
              <Select onChange={(e) => setObjectType((e.detail.selectedOption?.value as AbapObjectType) ?? "PROGRAM")}>
                {OBJECT_TYPES.map((t) => (
                  <Option key={t.value} value={t.value} selected={objectType === t.value} icon={t.icon}>
                    {t.label}
                    {!t.supported ? " (not yet live-connected)" : ""}
                  </Option>
                ))}
              </Select>
            </FormItem>
            <FormItem label="Package *">
              <Input value={pkg} onInput={(e) => setPkg(e.target.value)} placeholder="e.g. ZCC" />
            </FormItem>
          </FormGroup>
          <FormGroup titleText="Classification">
            <FormItem label="Business process area">
              <Input value={businessArea} onInput={(e) => setBusinessArea(e.target.value)} placeholder="e.g. Materials" />
            </FormItem>
            <FormItem label="Business criticality">
              <Select onChange={(e) => setCriticality((e.detail.selectedOption?.value as "H" | "M" | "L") ?? "M")}>
                <Option value="H" selected={criticality === "H"}>
                  High
                </Option>
                <Option value="M" selected={criticality === "M"}>
                  Medium
                </Option>
                <Option value="L" selected={criticality === "L"}>
                  Low
                </Option>
              </Select>
            </FormItem>
            <FormItem label="Owner">
              <Input value={owner} onInput={(e) => setOwner(e.target.value)} placeholder="e.g. your name" />
            </FormItem>
          </FormGroup>
        </Form>
        <BusyIndicator active={busy}>
          <Bar
            design="FloatingFooter"
            endContent={
              <Button design="Emphasized" disabled={!programName.trim() || !pkg.trim() || busy} onClick={handleCreate}>
                Create &amp; run discovery + analysis →
              </Button>
            }
          />
        </BusyIndicator>
      </Panel>
    </div>
  );
}

function BulkUploadForm() {
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
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Panel headerText="Upload Clean Core intake list">
        <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          <Text>
            Upload an Excel file with the programs to assess. Expected columns: <b>Program Name</b>, Object Type
            (Program/Class/Function Group/Include/Interface/CDS View — defaults to Program), Package, Business
            Process Area, Business Criticality (H/M/L), Notes/Owner.
          </Text>
          <FileUploader accept=".xlsx,.xls" onChange={(e) => setFile(e.target.files?.[0] ?? null)}>
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
