import { createApp } from "./app";

const { app } = createApp();
const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  console.log(`fs2-cc-automation-app server listening on :${port} (SAP_INTEGRATION_MODE=${process.env.SAP_INTEGRATION_MODE ?? "mock"})`);
});
