# SAP-side integration spec: Application Log (SLG1) + ZCC_CHG_HDR/ZCC_CHG_ITEM

## Context

This app (server/src/sap/RealAdtClient.ts) currently talks to SHD200SYSTEM
exclusively through standard ADT REST endpoints (`/sap/bc/adt/...`) over one
BTP destination. Two new requirements can't be met that way, because neither
SLG1 (`BAL_LOG_*` function modules) nor arbitrary custom Z-tables have a
generic ADT REST surface:

1. Every audit-trail event for a migrated object should land in the SAP
   Application Log (SLG1), under:
   - Object: `ZCC_TEST`
   - Subobject: `ZCC_MIG_APP`
   - External ID: the ABAP object name (e.g. `ZTEST_VK2`)
2. Every fix cycle should write a header row to `ZCC_CHG_HDR` and one item
   row per finding/fix to `ZCC_CHG_ITEM`, for later reporting.

Both need a custom SAP-side service (RFC-enabled function module, or an
OData/REST service) that this app can call. This document specifies what
this app can send, so your ABAP team can build the receiving side.

## What this app already has to send, per fix cycle

- Object identity: name, ABAP object type, package, business area,
  criticality, owner, risk score/band.
- Transport request number (captured at Fix Review approval / Gate 2).
- The finding/fix list: ATC check ID, message, priority, extensibility
  level, fix description, replacement object, status (fixed/approved/etc).
- The full audit trail: timestamp, actor, action, from-state, to-state,
  free-text details — this is the source for the SLG1 messages.

## Connectivity

This app calls SHD200SYSTEM through one BTP destination
(`executeHttpRequest({ destinationName }, ...)` via `@sap-cloud-sdk/http-client`).
If the new service is exposed on the same host/client, this app can reuse
that destination as-is — no new connectivity setup needed on our side.
Flag it if you'd rather this run under a separate destination/auth scope.

## Proposed interface (one combined call; can split into two if you'd rather separate ownership)

`POST` to a path your team assigns, e.g.
`/sap/opu/odata/sap/ZCC_MIGRATION_SRV/ChangeSet` or a custom ICF handler.

Request body:

```json
{
  "objectName": "ZTEST_VK2",
  "objectType": "PROG",
  "package": "ZEPTEST",
  "transportNumber": "SHDK900123",
  "riskScore": 47,
  "header": {
    "businessArea": "Finance",
    "criticality": "M",
    "owner": "vsaini",
    "startedAt": "2026-07-20T09:00:00Z",
    "completedAt": "2026-07-29T10:00:00Z"
  },
  "items": [
    {
      "atcCheckId": "STATIC_USAGE_API_SELECT_STAR",
      "message": "SELECT * FROM mara",
      "priority": 2,
      "extensibilityLevel": "C",
      "fixDescription": "Replace direct SELECT on MARA with released CDS view I_Product.",
      "replacementObject": "I_Product",
      "status": "fixed"
    }
  ],
  "auditLog": [
    {
      "timestamp": "2026-07-29T09:40:00Z",
      "actor": "human:fix-review",
      "action": "fix-review-approve-write",
      "fromState": "AWAITING_FIX_REVIEW",
      "toState": "VALIDATING",
      "details": "TR SHDK900123 — write it"
    }
  ]
}
```

Expected server-side behavior:

1. Insert one `ZCC_CHG_HDR` row (mapping TBD — see below) and one
   `ZCC_CHG_ITEM` row per `items[]` entry, keyed by a shared change ID.
2. `BAL_LOG_CREATE` (object=`ZCC_TEST`, subobject=`ZCC_MIG_APP`,
   extnumber=`objectName`), then `BAL_LOG_MSG_ADD`/`BAL_LOG_MSG_ADD_FREE_TEXT`
   once per `auditLog[]` entry, then `BAL_DB_SAVE`.
3. Response: the created change-header ID and the SLG1 log
   number/handle, for traceability back into this app.

## Open items — needed before this app's side can be finalized

- **DDIC field list for `ZCC_CHG_HDR` and `ZCC_CHG_ITEM`** (SE11 export or
  screenshot is enough) — the payload above is a proposal, not a fixed
  contract; field names/types need to match your actual tables.
- Confirm one combined endpoint is fine, or whether SLG1 and the Z-tables
  should be two separate calls (e.g. different owning teams).
- The real endpoint path/binding once built, and which destination/auth to
  call it under.

## Once the service exists

This app will call it once per program, right after Gate 2 approval (the
same point the tech-spec report is generated today —
`orchestrator.ts` around the `gate2Decision` approve branch), sending the
full fix summary and audit trail for that program. A failure to write the
log/table should not block or roll back the SAP write/transport release
that already happened — it should be reported to the user as a
non-fatal warning (same "graceful degradation, never throw" pattern this
app already uses for ATC and AI Core failures).
