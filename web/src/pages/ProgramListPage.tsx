import "@ui5/webcomponents-fiori/dist/illustrations/EmptyList.js";
import {
  Breadcrumbs,
  BreadcrumbsItem,
  Button,
  BusyIndicator,
  DynamicPage,
  DynamicPageHeader,
  DynamicPageTitle,
  FlexBox,
  IllustratedMessage,
  Input,
  Label,
  Option,
  Select,
  Table,
  TableCell,
  TableColumn,
  TableRow,
  Text,
  Title,
} from "@ui5/webcomponents-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { LevelBadge, RiskBadge, StateBadge } from "../components/Badges";
import { objectTypeLabel } from "../components/objectTypes";
import { ProgramSummary, WorkflowState } from "../types";

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "ALL", label: "All statuses" },
  { value: "OPEN", label: "In progress" },
  { value: "AWAITING_HUMAN_REVIEW_1", label: "Awaiting review (Gate 1)" },
  { value: "AWAITING_FIX_REVIEW", label: "Awaiting fix review" },
  { value: "AWAITING_HUMAN_REVIEW_2", label: "Awaiting review (Gate 2)" },
  { value: "PARKED", label: "Parked" },
  { value: "ESCALATED", label: "Escalated" },
  { value: "DONE", label: "Done" },
];

const OPEN_STATES: WorkflowState[] = [
  "UPLOADED",
  "GIT_BASELINED",
  "DISCOVERED",
  "ANALYZED",
  "BASELINING_TESTS",
  "REMEDIATING",
  "VALIDATING",
  "TRANSPORT_RELEASED",
  "DOCUMENTED",
];

const REVIEW_STATES: WorkflowState[] = ["AWAITING_HUMAN_REVIEW_1", "AWAITING_FIX_REVIEW", "AWAITING_HUMAN_REVIEW_2"];

function Kpi({ value, label, onClick }: { value: number; label: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "0.75rem 1.25rem",
        cursor: onClick ? "pointer" : "default",
        borderRight: "1px solid var(--sapList_BorderColor)",
      }}
    >
      <Title level="H2" style={{ lineHeight: 1.1 }}>
        {value}
      </Title>
      <Label>{label}</Label>
    </div>
  );
}

export function ProgramListPage() {
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [criticalityFilter, setCriticalityFilter] = useState("ALL");
  const navigate = useNavigate();

  useEffect(() => {
    api
      .listPrograms()
      .then(setPrograms)
      .finally(() => setLoading(false));
  }, []);

  const kpis = useMemo(
    () => ({
      total: programs.length,
      review: programs.filter((p) => REVIEW_STATES.includes(p.state)).length,
      escalated: programs.filter((p) => p.state === "ESCALATED").length,
      done: programs.filter((p) => p.state === "DONE").length,
    }),
    [programs]
  );

  const filtered = useMemo(() => {
    return programs.filter((p) => {
      if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !p.package.toLowerCase().includes(search.toLowerCase())) {
        return false;
      }
      if (criticalityFilter !== "ALL" && p.criticality !== criticalityFilter) return false;
      if (statusFilter === "OPEN" && !OPEN_STATES.includes(p.state)) return false;
      if (statusFilter !== "ALL" && statusFilter !== "OPEN" && p.state !== statusFilter) return false;
      return true;
    });
  }, [programs, search, statusFilter, criticalityFilter]);

  return (
    <DynamicPage
      headerTitle={
        <DynamicPageTitle
          breadcrumbs={
            <Breadcrumbs>
              <BreadcrumbsItem>Clean Core Migration Cockpit</BreadcrumbsItem>
            </Breadcrumbs>
          }
          header={<Title level="H2">Programs</Title>}
          subHeader={<Label>Clean Core migration backlog</Label>}
          actions={
            <Button design="Emphasized" icon="add" onClick={() => navigate("/create")}>
              Create
            </Button>
          }
        />
      }
      headerContent={
        <DynamicPageHeader>
          <FlexBox>
            <Kpi value={kpis.total} label="Total programs" onClick={() => setStatusFilter("ALL")} />
            <Kpi value={kpis.review} label="Awaiting review" onClick={() => setStatusFilter("AWAITING_HUMAN_REVIEW_1")} />
            <Kpi value={kpis.escalated} label="Escalated" onClick={() => setStatusFilter("ESCALATED")} />
            <Kpi value={kpis.done} label="Done" onClick={() => setStatusFilter("DONE")} />
          </FlexBox>
        </DynamicPageHeader>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <FlexBox style={{ gap: "1rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <Label for="search">Search</Label>
            <Input id="search" placeholder="Program or package…" value={search} onInput={(e) => setSearch(e.target.value)} />
          </div>
          <div>
            <Label>Status</Label>
            <Select onChange={(e) => setStatusFilter(e.detail.selectedOption?.value ?? "ALL")}>
              {STATUS_FILTERS.map((s) => (
                <Option key={s.value} value={s.value} selected={statusFilter === s.value}>
                  {s.label}
                </Option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Criticality</Label>
            <Select onChange={(e) => setCriticalityFilter(e.detail.selectedOption?.value ?? "ALL")}>
              {[
                { value: "ALL", label: "All" },
                { value: "H", label: "High" },
                { value: "M", label: "Medium" },
                { value: "L", label: "Low" },
              ].map((c) => (
                <Option key={c.value} value={c.value} selected={criticalityFilter === c.value}>
                  {c.label}
                </Option>
              ))}
            </Select>
          </div>
        </FlexBox>

        <BusyIndicator active={loading}>
          {!loading && programs.length === 0 ? (
            <IllustratedMessage
              name="EmptyList"
              titleText="No programs yet"
              subtitleText="Create a single object or upload an Excel intake list to get started."
            >
              <Button design="Emphasized" onClick={() => navigate("/create")}>
                Create your first object
              </Button>
            </IllustratedMessage>
          ) : (
            <Table
              columns={
                <>
                  <TableColumn>Program</TableColumn>
                  <TableColumn>Type</TableColumn>
                  <TableColumn>Package</TableColumn>
                  <TableColumn>Criticality</TableColumn>
                  <TableColumn>Status</TableColumn>
                  <TableColumn>Extensibility</TableColumn>
                  <TableColumn>Risk</TableColumn>
                  <TableColumn>Findings</TableColumn>
                </>
              }
              noDataText="No programs match these filters."
              onRowClick={(e) => {
                const id = e.detail.row?.getAttribute("data-program-id");
                if (id) navigate(`/programs/${id}`);
              }}
            >
              {filtered.map((p) => (
                <TableRow key={p.id} type="Active" data-program-id={p.id}>
                  <TableCell>
                    <Text style={{ fontWeight: "bold" }}>{p.name}</Text>
                  </TableCell>
                  <TableCell>
                    <Text>{objectTypeLabel(p.objectType)}</Text>
                  </TableCell>
                  <TableCell>
                    <Text>{p.package}</Text>
                  </TableCell>
                  <TableCell>
                    <Text>{p.criticality}</Text>
                  </TableCell>
                  <TableCell>
                    <StateBadge state={p.state} />
                  </TableCell>
                  <TableCell>
                    <LevelBadge level={p.worstExtensibilityLevel} />
                  </TableCell>
                  <TableCell>
                    <RiskBadge riskScore={p.riskScore} />
                  </TableCell>
                  <TableCell>
                    <Text>{p.findingsCount}</Text>
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          )}
        </BusyIndicator>
      </div>
    </DynamicPage>
  );
}
