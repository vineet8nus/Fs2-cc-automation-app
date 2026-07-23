import { createApp } from "./app";
import { createProgramStore } from "./store";

async function main() {
  const store = await createProgramStore();
  const { app } = createApp(store);
  const port = Number(process.env.PORT ?? 4000);

  app.listen(port, () => {
    console.log(`fs2-cc-automation-app server listening on :${port} (SAP_INTEGRATION_MODE=${process.env.SAP_INTEGRATION_MODE ?? "mock"})`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
