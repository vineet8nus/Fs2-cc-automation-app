import { MessageStrip, ShellBar, ShellBarItem } from "@ui5/webcomponents-react";
import { useEffect, useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { api } from "./api/client";
import { NewProgramPage } from "./pages/NewProgramPage";
import { ProgramDetailPage } from "./pages/ProgramDetailPage";
import { ProgramListPage } from "./pages/ProgramListPage";
import { RetroPage } from "./pages/RetroPage";
import { UploadPage } from "./pages/UploadPage";

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
        <ShellBarItem icon="add" text="New object" onClick={() => navigate("/programs/new")} />
        <ShellBarItem icon="upload-to-cloud" text="Bulk upload" onClick={() => navigate("/")} />
        <ShellBarItem icon="list" text="Programs" onClick={() => navigate("/programs")} />
        <ShellBarItem icon="bar-chart" text="Process retro" onClick={() => navigate("/retro")} />
      </ShellBar>
      {isMock && sapIntegrationMode !== null && (
        <MessageStrip design="Negative" hideCloseButton style={{ borderRadius: 0 }}>
          <b>Not connected to SHD200SYSTEM.</b> This deployment is running in mock mode — every program name you
          enter returns the same simulated source, findings, and risk score for demonstration purposes. No real
          SAP program has been read or analyzed. Real connectivity is a documented, unimplemented extension point
          (server/src/sap/RealAdtClient.ts) pending the OAuth grant type and destination binding.
        </MessageStrip>
      )}
      <Routes>
        <Route path="/" element={<UploadPage />} />
        <Route path="/programs" element={<ProgramListPage />} />
        <Route path="/programs/new" element={<NewProgramPage />} />
        <Route path="/programs/:id" element={<ProgramDetailPage />} />
        <Route path="/retro" element={<RetroPage />} />
      </Routes>
    </div>
  );
}
