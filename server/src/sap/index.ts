import { SapClient } from "./SapClient";
import { MockSapClient } from "./MockSapClient";
import { RealAdtClient } from "./RealAdtClient";

export function createSapClient(): SapClient {
  const mode = process.env.SAP_INTEGRATION_MODE ?? "mock";
  if (mode === "real") {
    return new RealAdtClient(process.env.SAP_DESTINATION_NAME ?? "SHD200SYSTEM");
  }
  return new MockSapClient();
}

export * from "./SapClient";
