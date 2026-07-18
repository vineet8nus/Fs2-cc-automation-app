import { ShellBar, ShellBarItem } from "@ui5/webcomponents-react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { ProgramDetailPage } from "./pages/ProgramDetailPage";
import { ProgramListPage } from "./pages/ProgramListPage";
import { RetroPage } from "./pages/RetroPage";
import { UploadPage } from "./pages/UploadPage";

export function App() {
  const navigate = useNavigate();

  return (
    <div>
      <ShellBar
        primaryTitle="Clean Core Migration Cockpit"
        secondaryTitle="SHD200SYSTEM · client 200 (mock mode)"
        onLogoClick={() => navigate("/")}
      >
        <ShellBarItem icon="upload-to-cloud" text="Upload" onClick={() => navigate("/")} />
        <ShellBarItem icon="list" text="Programs" onClick={() => navigate("/programs")} />
        <ShellBarItem icon="bar-chart" text="Process retro" onClick={() => navigate("/retro")} />
      </ShellBar>
      <Routes>
        <Route path="/" element={<UploadPage />} />
        <Route path="/programs" element={<ProgramListPage />} />
        <Route path="/programs/:id" element={<ProgramDetailPage />} />
        <Route path="/retro" element={<RetroPage />} />
      </Routes>
    </div>
  );
}
