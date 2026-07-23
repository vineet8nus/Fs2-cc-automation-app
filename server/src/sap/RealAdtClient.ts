import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import { DependencyObject } from "../domain/types";
import { AtcRawFinding, ObjectSource, SapClient, UnitTestCaseResult } from "./SapClient";
import { extractDependencies, runStaticAtcRules } from "./staticCleanCoreRules";

/**
 * Accumulates cookies and the CSRF token across an entire multi-request
 * flow, since a single upfront capture isn't enough: the LOCK call itself
 * sets an additional session-affinity cookie that must be picked up from
 * *that* response and carried forward into the write/unlock/activate calls
 * that follow, or they risk landing in a different backend session.
 */
class SapSession {
  private cookies = new Map<string, string>();
  private csrfToken?: string;

  absorb(headers: Record<string, unknown> | undefined) {
    const setCookie = headers?.["set-cookie"] as string[] | undefined;
    for (const c of setCookie ?? []) {
      const pair = c.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const token = headers?.["x-csrf-token"] as string | undefined;
    if (token && token.toLowerCase() !== "required") this.csrfToken = token;
  }

  headers(stateful = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.cookies.size > 0) h["Cookie"] = Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    if (this.csrfToken) h["X-CSRF-Token"] = this.csrfToken;
    if (stateful) h["X-sap-adt-sessiontype"] = "stateful";
    return h;
  }
}

/**
 * Real connectivity to SHD200SYSTEM (RISE S/4HANA 2023, client 200) over the
 * ADT REST API, via the BTP destination + Cloud Connector on-premise proxy
 * (confirmed live per docs/design/clean-core-migration-design.md §3a/§9 —
 * BasicAuthentication against a named user, routed through Cloud Connector
 * location "Training-BC-Dev").
 *
 * Status: read path — readObjectSource (live ADT source read),
 * getDependencies (static-text extraction, not a full ADT where-used
 * call), runAtcCheck (a static rule engine standing in for real ATC — see
 * staticCleanCoreRules.ts), and runAbapUnit (honestly returns no cases
 * rather than fabricating results, since real ABAP Unit execution isn't
 * wired up).
 *
 * Write path — syntaxCheckAndActivate is implemented and live-tested
 * against SHD200SYSTEM: lock -> write source -> unlock -> activate (in
 * that order — activating while still holding the edit lock fails with an
 * ENQUEUE self-conflict, "User X is currently editing", even under the
 * identical session). Every write is attributed to whichever user the
 * destination's stored credential resolves to (currently the named
 * personal user `VINEET` on SHD200SYSTEM) — see §6.5's read-only-vs-write
 * scoping rationale for why a dedicated technical/communication user
 * should eventually replace that for anything beyond this app's current
 * human-gated, single-approver use.
 *
 * objectExists is still an explicit unimplemented stub.
 */
export class RealAdtClient implements SapClient {
  constructor(private readonly destinationName: string) {}

  private notConfigured(method: string): never {
    throw new Error(
      `RealAdtClient.${method}() is not implemented yet against destination "${this.destinationName}". ` +
        `Set SAP_INTEGRATION_MODE=mock to run against the built-in mock data.`
    );
  }

  /**
   * `objectType` routes to the correct ADT collection for the object being
   * read — Includes and Classes live under different URI collections than
   * Programs and are not readable via the programs/programs endpoint.
   * Omitting it (every call site for the primary object being migrated)
   * preserves the exact original behavior: reads a Program, unchanged.
   */
  async readObjectSource(programName: string, objectType?: string): Promise<ObjectSource> {
    const encodedName = encodeURIComponent(programName.toLowerCase());
    if (objectType === "INCLUDE") {
      const response = await executeHttpRequest(
        { destinationName: this.destinationName },
        { method: "get", url: `/sap/bc/adt/programs/includes/${encodedName}/source/main`, headers: { Accept: "text/plain" } },
        { fetchCsrfToken: false }
      );
      return { name: programName, type: "INCL", source: String(response.data) };
    }
    if (objectType === "CLASS") {
      const response = await executeHttpRequest(
        { destinationName: this.destinationName },
        { method: "get", url: `/sap/bc/adt/oo/classes/${encodedName}/source/main`, headers: { Accept: "text/plain" } },
        { fetchCsrfToken: false }
      );
      return { name: programName, type: "CLAS", source: String(response.data) };
    }
    const response = await executeHttpRequest(
      { destinationName: this.destinationName },
      {
        method: "get",
        url: `/sap/bc/adt/programs/programs/${encodedName}/source/main`,
        headers: { Accept: "text/plain" },
      },
      { fetchCsrfToken: false }
    );
    return { name: programName, type: "PROG", source: String(response.data) };
  }

  async getDependencies(programName: string): Promise<DependencyObject[]> {
    const source = await this.readObjectSource(programName);
    return extractDependencies(source.source);
  }

  /**
   * Real ATC on SAP BTP / central S/4HANA (`/atc/runs`-style endpoints,
   * worklist XML) isn't wired up yet — this runs the static rule engine
   * (see staticCleanCoreRules.ts) against the real source instead, so real
   * programs get real findings now rather than waiting on the full ATC
   * integration. `_objectNames` is accepted for interface parity with the
   * mock client but isn't needed by the static engine.
   */
  async runAtcCheck(_objectNames: string[], currentSource: string): Promise<AtcRawFinding[]> {
    return runStaticAtcRules(currentSource);
  }

  /**
   * Real ADT Unit Test execution (`/sap/bc/adt/abapunit/testruns`) isn't
   * wired up yet. Returning no cases (rather than throwing) is the honest
   * answer — "nothing has actually been run" — and lets
   * baselineTestAgent's existing not-yet-verified placeholder do its job
   * instead of crashing real-mode discovery over an unimplemented method.
   */
  async runAbapUnit(_programName: string): Promise<UnitTestCaseResult[]> {
    return [];
  }

  /**
   * Experimental: triggers a real ATC run via the standard create-worklist
   * -> run -> poll-worklist flow, against the system's actual configured
   * check variant (ZNUS_SCI_DEF_CENTRAL on SHD200SYSTEM, discovered via
   * /sap/bc/adt/atc/customizing). Not yet part of the SapClient interface —
   * this is a diagnostic/proving step (see /api/diagnostics/atc-trigger)
   * while the exact request/response shapes get nailed down against the
   * real system. Doesn't modify any ABAP object; safe to run repeatedly.
   */
  async triggerAtcRun(objectUri: string, checkVariant: string): Promise<{ worklistId: string; runResponse: unknown; worklistXml: string }> {
    const session = new SapSession();
    const opts = { fetchCsrfToken: false } as const;

    const tokenFetch = await executeHttpRequest(
      { destinationName: this.destinationName },
      { method: "get", url: "/sap/bc/adt/discovery", headers: { "X-CSRF-Token": "Fetch" } },
      opts
    );
    session.absorb(tokenFetch.headers);

    const createWorklist = await executeHttpRequest(
      { destinationName: this.destinationName },
      { method: "post", url: `/sap/bc/adt/atc/worklists?checkVariant=${encodeURIComponent(checkVariant)}`, headers: { Accept: "text/plain", ...session.headers() } },
      opts
    );
    session.absorb(createWorklist.headers);
    const worklistId = String(createWorklist.data).trim();

    const runBody = `<?xml version="1.0" encoding="UTF-8"?>
<atc:run xmlns:atc="http://www.sap.com/adt/atc" xmlns:adtcore="http://www.sap.com/adt/core" maximumVerdicts="100">
  <objectSets>
    <objectSet kind="inclusive">
      <adtcore:objectReferences>
        <adtcore:objectReference adtcore:uri="${objectUri}"/>
      </adtcore:objectReferences>
    </objectSet>
  </objectSets>
</atc:run>`;

    const runResponse = await executeHttpRequest(
      { destinationName: this.destinationName },
      {
        method: "post",
        url: `/sap/bc/adt/atc/runs?worklistId=${encodeURIComponent(worklistId)}`,
        data: runBody,
        headers: { "Content-Type": "application/vnd.sap.atc.run.request.v1+xml", Accept: "application/xml", ...session.headers() },
      },
      opts
    );
    session.absorb(runResponse.headers);

    const worklist = await executeHttpRequest(
      { destinationName: this.destinationName },
      {
        method: "get",
        url: `/sap/bc/adt/atc/worklists/${encodeURIComponent(worklistId)}?includeExemptedFindings=false`,
        // The generic "application/xml" Accept the original diagnostic used
        // gets a 406 here — this resource only negotiates its own
        // versioned media type, confirmed against SHD200SYSTEM.
        headers: { Accept: "application/atc.worklist.v1+xml", ...session.headers() },
      },
      opts
    );

    return { worklistId, runResponse: runResponse.data, worklistXml: String(worklist.data) };
  }

  /**
   * The real write path: lock -> write source -> unlock -> activate, the
   * same sequence Eclipse ADT performs on save+activate. Attributed to
   * whichever user the destination's stored credential resolves to
   * (currently the named personal user configured on SHD200SYSTEM — see
   * the class doc). The lock is always released in a `finally`, even if
   * writing the source or activation throws, so a failed attempt doesn't
   * leave the object locked for the next one.
   */
  async syntaxCheckAndActivate(
    objectName: string,
    source: string
  ): Promise<{ syntaxOk: boolean; activated: boolean; messages: string[] }> {
    const encodedName = encodeURIComponent(objectName.toLowerCase());
    const objectUri = `/sap/bc/adt/programs/programs/${encodedName}`;
    const session = new SapSession();
    const opts = { fetchCsrfToken: false } as const;
    const messages: string[] = [];

    const tokenFetch = await executeHttpRequest(
      { destinationName: this.destinationName },
      { method: "get", url: "/sap/bc/adt/discovery", headers: { "X-CSRF-Token": "Fetch", "X-sap-adt-sessiontype": "stateful" } },
      opts
    );
    session.absorb(tokenFetch.headers);

    const lockResponse = await executeHttpRequest(
      { destinationName: this.destinationName },
      {
        method: "post",
        url: `${objectUri}?_action=LOCK&accessMode=MODIFY`,
        headers: { Accept: "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.Result2", ...session.headers(true) },
      },
      opts
    );
    session.absorb(lockResponse.headers); // critical: LOCK sets the session-affinity cookie the rest of this flow depends on
    const lockHandleMatch = String(lockResponse.data).match(/<LOCK_HANDLE>([^<]*)<\/LOCK_HANDLE>/);
    const lockHandle = lockHandleMatch?.[1];
    if (!lockHandle) {
      messages.push(`Could not acquire a lock handle: ${String(lockResponse.data).slice(0, 300)}`);
      return { syntaxOk: false, activated: false, messages };
    }
    messages.push(`Locked ${objectName} (handle acquired).`);

    try {
      const writeResponse = await executeHttpRequest(
        { destinationName: this.destinationName },
        {
          method: "put",
          url: `${objectUri}/source/main?lockHandle=${encodeURIComponent(lockHandle)}`,
          data: source,
          headers: { "Content-Type": "text/plain; charset=utf-8", ...session.headers(true) },
        },
        opts
      );
      session.absorb(writeResponse.headers);
      messages.push("Source written (inactive version).");
    } catch (err) {
      if (err && typeof err === "object") (err as { debugMessages?: string[] }).debugMessages = messages;
      // Still attempt to release the lock below before rethrowing.
      await executeHttpRequest(
        { destinationName: this.destinationName },
        { method: "post", url: `${objectUri}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`, headers: { ...session.headers(true) } },
        opts
      ).catch(() => undefined);
      throw err;
    }

    // Unlock BEFORE activating — a live test against SHD200SYSTEM showed
    // activation failing with "User X is currently editing" (an ENQUEUE
    // self-conflict) while the edit-lock was still held from the write
    // step, even carrying the identical session cookies. Releasing the
    // lock first (activation operates on the already-saved inactive
    // version, independent of any edit lock) resolved it.
    const unlockResponse = await executeHttpRequest(
      { destinationName: this.destinationName },
      { method: "post", url: `${objectUri}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`, headers: { ...session.headers(true) } },
      opts
    ).catch((err) => {
      messages.push(`Warning: unlock failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (unlockResponse) session.absorb(unlockResponse.headers);
    messages.push(`Unlocked ${objectName}.`);

    try {
      const activationBody = `<?xml version="1.0" encoding="UTF-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReference adtcore:uri="${objectUri}" adtcore:name="${objectName.toUpperCase()}"/>
</adtcore:objectReferences>`;
      const activationResponse = await executeHttpRequest(
        { destinationName: this.destinationName },
        {
          method: "post",
          url: "/sap/bc/adt/activation?method=activate&preauditRequested=true",
          data: activationBody,
          headers: { "Content-Type": "application/xml", Accept: "application/xml", ...session.headers(true) },
        },
        opts
      );
      const activationXml = String(activationResponse.data);
      const errorMessages = [...activationXml.matchAll(/type="[EA]"[^>]*>[\s\S]*?<[^:>]*:?shortText>([^<]*)</g)].map((m) => m[1]);
      messages.push(...errorMessages);
      const activated = errorMessages.length === 0;
      messages.push(activated ? `${objectName} activated successfully.` : `Activation reported ${errorMessages.length} error(s).`);
      return { syntaxOk: activated, activated, messages };
    } catch (err) {
      // Attach whatever we learned before the failure so it isn't lost —
      // the caller only sees the raw HTTP error otherwise, with no
      // visibility into which step failed or what session state led there.
      if (err && typeof err === "object") (err as { debugMessages?: string[] }).debugMessages = messages;
      throw err;
    }
  }

  /**
   * Experimental: creates a brand-new INTF/CLAS object shell via ADT's
   * object-creation protocol, then (optionally) writes real source into it
   * and activates. Modeled directly on the `abap-adt-api` reference
   * implementation's `CreatableTypes` table (objectcreator.ts) — same root
   * element names, namespaces, creation paths, and the (surprising, but
   * confirmed-working) generic wildcard Content-Type (see the request
   * below), rather than a versioned media type. Not part of the SapClient
   * interface; this is
   * proving-ground code for the Clean Core Governance app objects
   * (ZIF_ZCC_x / ZCL_ZCC_x) in package ZTEST_VK, same diagnostic-route
   * pattern as triggerAtcRun.
   *
   * Note: `ZCL_ZCC_APPLOG` was independently created as an empty shell
   * before this method existed (confirmed via ADT read — see chat), so
   * calling this again for that exact name will fail (object already
   * exists). Use writeAndActivateSource below to populate an existing shell
   * instead.
   */
  static readonly CREATABLE_TYPES: Record<string, { creationPath: string; rootName: string; nameSpace: string; extra?: string }> = {
    "CLAS/OC": { creationPath: "oo/classes", rootName: "class:abapClass", nameSpace: 'xmlns:class="http://www.sap.com/adt/oo/classes"' },
    "INTF/OI": { creationPath: "oo/interfaces", rootName: "intf:abapInterface", nameSpace: 'xmlns:intf="http://www.sap.com/adt/oo/interfaces"' },
    "TABL/DT": { creationPath: "ddic/tables", rootName: "blue:blueSource", nameSpace: 'xmlns:blue="http://www.sap.com/wbobj/blue"' },
    "DDLS/DF": { creationPath: "ddic/ddl/sources", rootName: "ddl:ddlSource", nameSpace: 'xmlns:ddl="http://www.sap.com/adt/ddic/ddlsources"' },
    "SRVD/SRV": {
      // extra is required — a real 400 ("Service Definition type '' does
      // not exist") confirmed the type attribute must be set explicitly.
      creationPath: "ddic/srvd/sources",
      rootName: "srvd:srvdSource",
      nameSpace: 'xmlns:srvd="http://www.sap.com/adt/ddic/srvdsources"',
      extra: 'srvd:srvdSourceType="S"',
    },
    "BDEF/BDO": {
      // Confirmed against SHD200SYSTEM: the create-object body uses the
      // same generic "blue" wrapper as TABL/DT, not a dedicated bdef
      // namespace — a real 400 ("System expected the element blueSource")
      // corrected this from an initial guess.
      creationPath: "bo/behaviordefinitions",
      rootName: "blue:blueSource",
      nameSpace: 'xmlns:blue="http://www.sap.com/wbobj/blue"',
    },
  };

  /**
   * Service bindings are a distinct protocol, not a variant of createObject:
   * the create body embeds the service definition + binding version/type
   * instead of a plain packageRef, and there's no editable source/main text
   * — the binding activates directly like DDIC objects, via activateObjects.
   * Body shape confirmed by reading an existing real V4 UI binding
   * (ZEP_GL_POSTING_V4_WEB_API) on SHD200SYSTEM: srvb:services srvb:name is
   * the *service definition's* name (not the binding's own name, which was
   * my first, wrong guess), srvb:binding uses type="ODATA" version="V4"
   * category="1".
   */
  async createServiceBinding(params: {
    name: string;
    packageName: string;
    description: string;
    serviceDefinitionName: string;
    transportNumber: string;
    responsible: string;
  }): Promise<{ created: boolean; messages: string[] }> {
    const session = new SapSession();
    const opts = { fetchCsrfToken: false } as const;
    const messages: string[] = [];

    const tokenFetch = await executeHttpRequest(
      { destinationName: this.destinationName },
      { method: "get", url: "/sap/bc/adt/discovery", headers: { "X-CSRF-Token": "Fetch", "X-sap-adt-sessiontype": "stateful" } },
      opts
    );
    session.absorb(tokenFetch.headers);

    const body = `<?xml version="1.0" encoding="UTF-8"?>
<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:description="${params.description}" adtcore:name="${params.name.toUpperCase()}" adtcore:type="SRVB/SVB" adtcore:language="EN" adtcore:masterLanguage="EN" adtcore:responsible="${params.responsible.toUpperCase()}">
  <adtcore:packageRef adtcore:name="${params.packageName.toUpperCase()}"/>
  <srvb:services srvb:name="${params.serviceDefinitionName.toUpperCase()}">
    <srvb:content srvb:version="0001">
      <srvb:serviceDefinition adtcore:name="${params.serviceDefinitionName.toUpperCase()}"/>
    </srvb:content>
  </srvb:services>
  <srvb:binding srvb:category="1" srvb:type="ODATA" srvb:version="V4">
    <srvb:implementation adtcore:name="${params.name.toUpperCase()}"/>
  </srvb:binding>
</srvb:serviceBinding>`;

    try {
      const createResponse = await executeHttpRequest(
        { destinationName: this.destinationName },
        {
          method: "post",
          url: `/sap/bc/adt/businessservices/bindings?corrNr=${encodeURIComponent(params.transportNumber)}`,
          data: body,
          headers: { "Content-Type": "application/*", Accept: "application/*", ...session.headers(true) },
        },
        opts
      );
      messages.push(`HTTP ${createResponse.status}: created service binding ${params.name} in ${params.packageName}.`);
      return { created: true, messages };
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number; data?: unknown } };
      messages.push(`Create failed: ${e.message ?? String(err)}`);
      if (e.response) messages.push(`HTTP ${e.response.status}: ${String(e.response.data).slice(0, 800)}`);
      if (err && typeof err === "object") (err as { debugMessages?: string[] }).debugMessages = messages;
      throw err;
    }
  }

  async createObject(params: {
    objtype: keyof typeof RealAdtClient.CREATABLE_TYPES;
    name: string;
    packageName: string;
    description: string;
    transportNumber: string;
    responsible: string;
  }): Promise<{ created: boolean; messages: string[] }> {
    const { creationPath, rootName, nameSpace, extra } = RealAdtClient.CREATABLE_TYPES[params.objtype];
    const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const session = new SapSession();
    const opts = { fetchCsrfToken: false } as const;
    const messages: string[] = [];

    const tokenFetch = await executeHttpRequest(
      { destinationName: this.destinationName },
      { method: "get", url: "/sap/bc/adt/discovery", headers: { "X-CSRF-Token": "Fetch", "X-sap-adt-sessiontype": "stateful" } },
      opts
    );
    session.absorb(tokenFetch.headers);

    const body = `<?xml version="1.0" encoding="UTF-8"?>
<${rootName} ${nameSpace} xmlns:adtcore="http://www.sap.com/adt/core" adtcore:description="${escape(
      params.description
    )}" adtcore:name="${params.name.toUpperCase()}" adtcore:type="${params.objtype}" adtcore:language="EN" adtcore:masterLanguage="EN" adtcore:responsible="${params.responsible.toUpperCase()}"${
      extra ? ` ${extra}` : ""
    }>
  <adtcore:packageRef adtcore:name="${params.packageName.toUpperCase()}"/>
</${rootName}>`;

    try {
      const createResponse = await executeHttpRequest(
        { destinationName: this.destinationName },
        {
          method: "post",
          url: `/sap/bc/adt/${creationPath}?corrNr=${encodeURIComponent(params.transportNumber)}`,
          data: body,
          headers: { "Content-Type": "application/*", Accept: "application/*", ...session.headers(true) },
        },
        opts
      );
      messages.push(`HTTP ${createResponse.status}: created ${params.objtype} ${params.name} in ${params.packageName}.`);
      return { created: true, messages };
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number; data?: unknown } };
      messages.push(`Create failed: ${e.message ?? String(err)}`);
      if (e.response) messages.push(`HTTP ${e.response.status}: ${String(e.response.data).slice(0, 800)}`);
      if (err && typeof err === "object") (err as { debugMessages?: string[] }).debugMessages = messages;
      throw err;
    }
  }

  /**
   * Generalization of syntaxCheckAndActivate's lock -> write -> unlock ->
   * activate sequence to CLAS/INTF objects (not just PROG), for populating
   * a just-created or existing empty Clean Core Governance app object
   * (ZIF_ZCC_x / ZCL_ZCC_x) with real source. Kept as a separate method
   * rather than widening syntaxCheckAndActivate's signature, since that
   * method is part of the SapClient interface other call sites depend on
   * unchanged.
   */
  static collectionFor(objectType: "CLAS" | "INTF" | "TABL" | "DDLS" | "BDEF" | "SRVD" | "SRVB"): string {
    return { CLAS: "oo/classes", INTF: "oo/interfaces", TABL: "ddic/tables", DDLS: "ddic/ddl/sources", BDEF: "bo/behaviordefinitions", SRVD: "ddic/srvd/sources", SRVB: "businessservices/bindings" }[objectType];
  }

  /**
   * Activates one or more objects in a single call — required when two
   * objects reference each other (e.g. a RAP root's `composition of` and
   * the child's matching `association to parent`): neither can activate
   * alone since each references the other, confirmed against
   * ZI_CC_Chg/ZI_CC_ChgItem on SHD200SYSTEM. ADT's activation endpoint
   * accepts multiple objectReference entries in one POST for exactly this.
   */
  async activateObjects(refs: { uri: string; name: string }[]): Promise<{ activated: boolean; messages: string[] }> {
    const session = new SapSession();
    const opts = { fetchCsrfToken: false } as const;
    const messages: string[] = [];

    const tokenFetch = await executeHttpRequest(
      { destinationName: this.destinationName },
      { method: "get", url: "/sap/bc/adt/discovery", headers: { "X-CSRF-Token": "Fetch", "X-sap-adt-sessiontype": "stateful" } },
      opts
    );
    session.absorb(tokenFetch.headers);

    const activationBody = `<?xml version="1.0" encoding="UTF-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
${refs.map((r) => `  <adtcore:objectReference adtcore:uri="${r.uri}" adtcore:name="${r.name.toUpperCase()}"/>`).join("\n")}
</adtcore:objectReferences>`;
    const activationResponse = await executeHttpRequest(
      { destinationName: this.destinationName },
      {
        method: "post",
        url: "/sap/bc/adt/activation?method=activate&preauditRequested=true",
        data: activationBody,
        headers: { "Content-Type": "application/xml", Accept: "application/xml", ...session.headers(true) },
      },
      opts
    );
    const activationXml = String(activationResponse.data);
    const elementMatches = [...activationXml.matchAll(/type="[EA]"[^>]*>[\s\S]*?<[^:>]*:?shortText>([^<]*)</g)].map((m) => m[1]).filter(Boolean);
    const msgBlockMatches = [...activationXml.matchAll(/<msg[^>]*type="[EA]"[^>]*>([\s\S]*?)<\/msg>/g)]
      .flatMap((m) => [...m[1].matchAll(/<txt>([^<]*)<\/txt>/g)].map((t) => t[1]))
      .filter(Boolean);
    const errorMessages = elementMatches.length > 0 ? elementMatches : msgBlockMatches;
    const hasErrorMarkers = /type="[EA]"/.test(activationXml);
    if (errorMessages.length === 0 && hasErrorMarkers) {
      messages.push(`Activation reported errors but they couldn't be parsed — raw response: ${activationXml.slice(0, 2000)}`);
    } else {
      messages.push(...errorMessages);
    }
    const activated = errorMessages.length === 0 && !hasErrorMarkers;
    messages.push(activated ? `Activated: ${refs.map((r) => r.name).join(", ")}.` : `Activation reported ${errorMessages.length} error(s).`);
    return { activated, messages };
  }

  /** Lock -> write -> unlock only, no activation — for objects that need a combined multi-object activate (see activateObjects). */
  async writeObjectSourceOnly(
    objectName: string,
    objectType: "CLAS" | "INTF" | "TABL" | "DDLS" | "BDEF" | "SRVD",
    source: string,
    transportNumber?: string
  ): Promise<{ written: boolean; messages: string[] }> {
    const encodedName = encodeURIComponent(objectName.toLowerCase());
    const objectUri = `/sap/bc/adt/${RealAdtClient.collectionFor(objectType)}/${encodedName}`;
    const session = new SapSession();
    const opts = { fetchCsrfToken: false } as const;
    const messages: string[] = [];

    const tokenFetch = await executeHttpRequest(
      { destinationName: this.destinationName },
      { method: "get", url: "/sap/bc/adt/discovery", headers: { "X-CSRF-Token": "Fetch", "X-sap-adt-sessiontype": "stateful" } },
      opts
    );
    session.absorb(tokenFetch.headers);

    const lockResponse = await executeHttpRequest(
      { destinationName: this.destinationName },
      {
        method: "post",
        url: `${objectUri}?_action=LOCK&accessMode=MODIFY`,
        headers: { Accept: "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.Result2", ...session.headers(true) },
      },
      opts
    );
    session.absorb(lockResponse.headers);
    const lockHandleMatch = String(lockResponse.data).match(/<LOCK_HANDLE>([^<]*)<\/LOCK_HANDLE>/);
    const lockHandle = lockHandleMatch?.[1];
    if (!lockHandle) {
      messages.push(`Could not acquire a lock handle: ${String(lockResponse.data).slice(0, 300)}`);
      return { written: false, messages };
    }
    messages.push(`Locked ${objectName} (handle acquired).`);

    try {
      const writeResponse = await executeHttpRequest(
        { destinationName: this.destinationName },
        {
          method: "put",
          url: `${objectUri}/source/main?lockHandle=${encodeURIComponent(lockHandle)}${
            transportNumber ? `&corrNr=${encodeURIComponent(transportNumber)}` : ""
          }`,
          data: source,
          headers: { "Content-Type": "text/plain; charset=utf-8", ...session.headers(true) },
        },
        opts
      );
      session.absorb(writeResponse.headers);
      messages.push("Source written (inactive version).");
    } catch (err) {
      if (err && typeof err === "object") (err as { debugMessages?: string[] }).debugMessages = messages;
      await executeHttpRequest(
        { destinationName: this.destinationName },
        { method: "post", url: `${objectUri}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`, headers: { ...session.headers(true) } },
        opts
      ).catch(() => undefined);
      throw err;
    }

    const unlockResponse = await executeHttpRequest(
      { destinationName: this.destinationName },
      { method: "post", url: `${objectUri}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`, headers: { ...session.headers(true) } },
      opts
    ).catch((err) => {
      messages.push(`Warning: unlock failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (unlockResponse) session.absorb(unlockResponse.headers);
    messages.push(`Unlocked ${objectName}.`);
    return { written: true, messages };
  }

  async writeAndActivateObjectSource(
    objectName: string,
    objectType: "CLAS" | "INTF" | "TABL" | "DDLS" | "BDEF" | "SRVD",
    source: string,
    transportNumber?: string
  ): Promise<{ syntaxOk: boolean; activated: boolean; messages: string[] }> {
    const write = await this.writeObjectSourceOnly(objectName, objectType, source, transportNumber);
    if (!write.written) return { syntaxOk: false, activated: false, messages: write.messages };
    const objectUri = `/sap/bc/adt/${RealAdtClient.collectionFor(objectType)}/${encodeURIComponent(objectName.toLowerCase())}`;
    const activate = await this.activateObjects([{ uri: objectUri, name: objectName }]);
    return { syntaxOk: activate.activated, activated: activate.activated, messages: [...write.messages, ...activate.messages] };
  }

  /**
   * Confirms a replacement object (e.g. a released CDS view like
   * I_BillingDocument) genuinely exists in the repository, via ADT's
   * repository quick-search — a real check, not a name-format guess. A
   * network/API failure here is intentionally left to propagate (not
   * swallowed to a default), so a validation run fails loudly rather than
   * silently assuming a replacement exists when it couldn't be confirmed.
   */
  async objectExists(objectName: string): Promise<boolean> {
    const response = await executeHttpRequest(
      { destinationName: this.destinationName },
      {
        method: "get",
        url: `/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(objectName)}&maxResults=5`,
        headers: { Accept: "application/xml" },
      },
      { fetchCsrfToken: false }
    );
    const xml = String(response.data);
    const upperName = objectName.toUpperCase();
    return new RegExp(`adtcore:name="${upperName}"`, "i").test(xml);
  }
}
