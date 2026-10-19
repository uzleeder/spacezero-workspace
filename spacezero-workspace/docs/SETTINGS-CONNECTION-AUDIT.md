# Settings continuation review — 2026-09-30

Scope: Claude's Settings / Advanced consolidation (prompt 1 of 3). No live configuration values, grants, employee records, scores or business rules were changed during verification.

## Navigation and wording

One Settings entry leads to General, Security and authorized Advanced settings. Advanced groups are People & Access, Training & Development and Company Governance. Existing URLs remain available; `/admin/configuration` retains its redirect. Advanced destinations and the Standards editor have breadcrumb/return navigation. Mobile Advanced cards use one column and keep breadcrumb labels visible.

Development now describes recommendations, onboarding paths and assignment rules separately. The existing recommend/assign controls remain available. General validation errors now return HTTP 400 with entered text retained; successful additions show Changes saved. A malformed confirmation string that prevented System Access from rendering was corrected without changing grant/revoke behavior.

## Connection review

| Area | Persistence and operational reader | Access / audit findings |
| --- | --- | --- |
| Setup Requirements | SetupRequirement and targets in `routes/admin/setupSettings.js`; employee checklist/readiness in `lib/employeeSetup.js` and `routes/employeeRecord.js` | Advanced gate; requirement and audience changes audited. |
| Supervisor Permissions | SupervisorCapability in `routes/admin/supervisorPermissions.js`; capability checks in `lib/supervisorCapabilities.js` | Global page requires Advanced; existing ordinary Admin individual-supervisor management exception preserved. Grant/revoke events audited. |
| System Access | Same capability store, `system.config_access`, managed by `routes/admin/configuration.js` | Admin plus capability gate, including direct POST; existing bootstrap behavior preserved. Grant/revoke audited. |
| Security | OrgSetting via `routes/admin/settings.js`; `lib/employeeAccess.js` reads credential-owner policy and `routes/leave.js` reads final-approval policy | Admin gate, policy changes audited. |
| Training Configuration | OrgSetting in `routes/admin/setupSettings.js`; passing floor read by assignments, bulk assignment, course audience, onboarding and automation; call retention by `lib/callRetention.js`; scoring by evidence/skill engine | Advanced gate; validation and policy audit retained, including existing score recalculation on scoring-rule changes. |
| Skills | Shared Skill catalog in `routes/admin/development.js`; EmployeeSkill and evidence consumers | Advanced management gate; create/update/taxonomy/recalculation audits retained. General quick editor uses this same catalog, not a separate setting store. |
| Development | Paths/rules/recommendations managed in `routes/admin/development.js`; consumed by `lib/onboarding.js`, `lib/automation.js`, `lib/development.js` | Existing approved/published training checks and recommend/assign distinction retained. |
| Certifications | CertificationDefinition and EarnedCertification; `lib/certifications.js` evaluates courses, assessments and evidence-backed skill requirements | Advanced management gate; definition, issue and revoke auditing retained. |
| Standards | StandardsItem and versioned content in `routes/admin/standards.js`; operational standards pages use the same records | Advanced management gate; draft/publish/archive workflow retained. |
| Audit / Analytics | `routes/admin/misc.js` reads organization audit records and aggregate data | Advanced gate; read-only views. |

## Retained overlaps and limitations

- General's quick skill editor and Advanced Skills intentionally remain two entry points into one catalog. Their existing access levels were not merged or expanded.
- Standards remains accessible as an operational module and as an Advanced management destination; these are shared records, not duplicated configurations.
- Analytics was retained under Governance; no settings were deleted as obsolete.
- General skill deactivation now records an organization-scoped audit event only when an active skill actually changes.
- Training Configuration now renders invalid submissions with HTTP 400 and retains raw entered values, including scoring bands and follow-up schedules. Development, Skills and Certifications keep the current form on validation/network failure through a scoped enhancement; no drafts or secrets are stored in browser storage. Without JavaScript those three modules retain their existing redirect-based error behavior.
- Tenure maximum-month validation remains the existing schema. This review did not introduce new business validation rules.

## Verification

- Initial baseline: 326/327 passed; stale Advanced section-label assertion failed.
- After navigation/form changes: 328/329 passed; new destination coverage exposed the existing System Access template syntax error.
- After fixing that template: all 11 Admin Configuration tests passed, including every Advanced destination, role/capability denial, individual supervisor exception, and invalid-form persistence. The remaining 318 tests passed in the preceding full run.
- ESLint passed. JavaScript syntax and all 127 EJS templates validated after the fix. Release package check passed (381 files, excludes secrets and private data).
- Signed-in browser: Advanced hub and System Access rendered. At 390 px the hub used one column with no horizontal overflow; mobile breadcrumbs remained visible. No live configuration forms were submitted.

## Final completion follow-up

- Standardized existing save alerts to Changes saved; added missing Development/Certification save feedback.
- Added targeted confirmation for supervisor permissions, changed setup applicability/readiness, and organization-wide training/scoring changes. Cancelled submissions no longer leave the Save button disabled.
- Added unsaved-edit navigation protection to Development, Skills and Certifications and preserved other forms' edits after a successful save.
- Browser check: a rejected one-character Development path name remained in the form with the actual validation message and an enabled retry button. No path was created.
- Lint, all 127 template/syntax checks and release packaging passed (384 files; private data excluded).

Final regression result: PASS — all 332 tests passed, 0 failed, using an isolated temporary database. This full run includes the final code changes and supersedes the earlier partial-run results. Prompt 1/3 acceptance review is complete; existing duplicate entry points and non-JavaScript fallback behavior are documented above.
