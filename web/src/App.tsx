import { MessageStrip, ShellBar, ShellBarItem } from "@ui5/webcomponents-react";
import { useEffect, useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { api } from "./api/client";
import { CreateProgramPage } from "./pages/CreateProgramPage";
import { ProgramDetailPage } from "./pages/ProgramDetailPage";
import { ProgramListPage } from "./pages/ProgramListPage";
import { RetroPage } from "./pages/RetroPage";

export function App() {
  const navigate = useNavigate();
  const [sapIntegrationMode, setSapIntegrationMode] = useState<string | null>(null);

  useEffect(() => {
    api.health().then((h) => setSapIntegrationMode(h.sapIntegrationMode)).catch(() => setSapIntegrationMode("unknown"));
  }, []);

  const isMock = sapIntegrationMode !== "real";

  return (
    <div>
      <ShellBar
        primaryTitle="Clean Core Migration Cockpit"
        secondaryTitle={`SHD200SYSTEM · client 200${isMock ? " · SIMULATED DATA" : ""}`}
        onLogoClick={() => navigate("/")}
      >
        <ShellBarItem icon="list" text="Programs" onClick={() => navigate("/")} />
        <ShellBarItem icon="add" text="Create" onClick={() => navigate("/create")} />
        <ShellBarItem icon="bar-chart" text="Process retro" onClick={() => navigate("/retro")} />
      </ShellBar>
      {isMock && sapIntegrationMode !== null && (
        <MessageStrip design="Negative" hideCloseButton style={{ borderRadius: 0 }}>
          <b>Not connected to SHD200SYSTEM.</b> This deployment is running in mock mode — every program name you
          enter returns the same simulated source, findings, and risk score for demonstration purposes. No real
          SAP program has been read or analyzed.
        </MessageStrip>
      )}
      <Routes>
        <Route path="/" element={<ProgramListPage />} />
        <Route path="/create" element={<CreateProgramPage />} />
        <Route path="/programs/:id" element={<ProgramDetailPage />} />
        <Route path="/retro" element={<RetroPage />} />
      </Routes>
    </div>
  );
}
