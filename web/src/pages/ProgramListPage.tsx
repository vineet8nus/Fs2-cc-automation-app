import { BusyIndicator, Table, TableCell, TableColumn, TableRow, Text, Title } from "@ui5/webcomponents-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { LevelBadge, RiskBadge, StateBadge } from "../components/Badges";
import { ProgramSummary } from "../types";

export function ProgramListPage() {
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .listPrograms()
      .then(setPrograms)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ maxWidth: 1200, margin: "2rem auto", padding: "0 1rem" }}>
      <Title level="H2" style={{ marginBottom: "1rem" }}>
        Programs ({programs.length})
      </Title>
      <BusyIndicator active={loading}>
        <Table
          columns={
            <>
              <TableColumn>Program</TableColumn>
              <TableColumn>Package</TableColumn>
              <TableColumn>Criticality</TableColumn>
              <TableColumn>Status</TableColumn>
              <TableColumn>Extensibility</TableColumn>
              <TableColumn>Risk</TableColumn>
              <TableColumn>Findings</TableColumn>
            </>
          }
          noDataText="No programs yet — upload an Excel intake list to get started."
          onRowClick={(e) => {
            const id = e.detail.row?.getAttribute("data-program-id");
            if (id) navigate(`/programs/${id}`);
          }}
        >
          {programs.map((p) => (
            <TableRow key={p.id} type="Active" data-program-id={p.id}>
              <TableCell>
                <Text>{p.name}</Text>
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
      </BusyIndicator>
    </div>
  );
}
