# SpaceZero — Office Management improvement prompt

Status: discussion draft, prepared 6 November 2026. Apply after the owner agrees to the proposed scope. Confirmed requirement: **Office manager only; no employee request portal.**

## Objective

Improve the existing `/office` feature into a practical private workspace for managing equipment, desk allocation and repairs. Make daily work fast and records consistent. Build within the existing Express, EJS, Prisma and CSS architecture. Do not replace the framework or rebuild unrelated platform features.

Read `docs/OFFICE-MANAGEMENT-REVIEW-2026-11-06.md`, repository instructions, current Office routes, services, templates, styles, schemas, tests and related My Desk/setup flows first. Inspect current changes before editing and preserve other contributors’ work. Recheck findings against current code; the audit is a baseline, not a substitute for inspection.

## Scope and non-negotiable behavior

- Keep Office access controlled by the existing Office Manager capability, organization scope and impersonation restriction. Do not grant access merely because someone is an Admin or Supervisor. Enforce authorization on every page, mutation, export and detail endpoint.
- Do not create an employee service/request portal. Keep existing My Desk functionality separate and compatible. Any change to its authorization or credential access must be explicitly described before implementation.
- Preserve records, associations, existing passwords, encryption keys and credential ciphertext. Do not seed replacement users, reset credentials or delete inventory to simplify migration.
- Preserve desk IDs and encryption associated-data compatibility. Never include desk credentials in exports, history payloads, search results, AI context or ordinary page data.
- Use English throughout. Match existing SpaceZero components and light/dark themes. Do not deploy, push a release or send real notifications as part of local verification unless explicitly authorized.

## Information architecture and interaction design

Add a permission-aware Office sidebar entry. Organize the workspace into Overview, Assets, Desks, Repairs and Activity. Each tab must have real working functionality; do not add empty decorative sections.

Overview: show actionable summaries with precise definitions and links to matching filtered lists. Include incomplete records and repair follow-ups. Distinguish total, assigned, unassigned, confirmed available, under repair and retired. An unassigned item is not automatically available. Avoid speculative utilization percentages or fabricated charts.

Assets: place search, category, lifecycle, condition, location and custodian filters above the table. Use URL-backed filters, sorting and pagination; preserve them across detail views, saves and browser Back/Forward. Offer 25/50/100 rows per page and clear result counts. Preserve combined filters when using summary links, except where an explicitly labelled reset is intended. Include Clear filters and useful empty states.

Use a sticky compact toolbar and table headings below the existing application header. Measure offsets at responsive sizes. Do not pin a tall decorative heading that consumes most of the viewport or hides focused fields. Use meaningful default columns: asset tag, item/model, category, custodian/desk, location, lifecycle and condition. Secondary information belongs in a detail drawer. Add/Edit forms open on intent, not permanently above the inventory.

Drawers become full-screen panels on small screens. Support Escape, keyboard focus containment where appropriate, focus restoration, visible errors, unsaved-change handling and cancel. Preserve user input after validation errors. Use in-page confirmations for destructive actions. Buttons must have accessible names; statuses must not depend on color alone.

Keep white/neutral surfaces and restrained warm accents in light mode; distinct dark surfaces and readable borders in dark mode. Reuse theme tokens. Provide comfortable action targets, clear selection states and readable table density. Avoid page-wide horizontal scrolling; offer a focused mobile row/detail experience.

## Inventory and assignment model

Introduce stable human-readable asset tags unique within an organization. Retain existing database IDs and original names. Separate model/product from each physical item; do not strip trailing numbers to infer product identity. Give bulk-created items unique tags without restarting conflicting numbering. Preview bulk creation before committing and enforce a bounded batch size.

Add usable categories for actual inventory, including keyboards, mice, furniture and appliances. Use an explicit physical location independent of holder. Keep condition separate from lifecycle and custody. Document allowed transitions and their effects; broken equipment cannot appear as ready to assign simply because it has no holder.

Link actual assets to desks rather than maintaining parallel equipment strings. An asset must not be actively assigned to two desks or people at once. Support desk equipment with a desk location and an explicitly defined custodian policy; do not require every shared asset to have a person. Check-out, return, transfer and repair transitions must update the authoritative record and history atomically. Validate organization and employee eligibility server-side. Preserve historical references for former employees.

Use a conflict/version check or equivalent transactional control to avoid silently overwriting another manager’s changes. Bulk operations must state whether selection means this page or all matching records, validate each target, and report failures without misleading success totals.

Desks: show number, team, occupant, linked equipment and readiness. Provide filters for occupied, unoccupied and incomplete records. Preserve legacy free-text values until manually mapped; do not invent asset matches from similar names. Prefer organization-scoped team relationships where feasible while retaining necessary historical labels. Do not impose a one-desk-per-person constraint until actual practice is confirmed.

Review the existing employee desk-claim path before linking records. A desk reassignment must not unintentionally expose previous credentials or transfer custody. Keep current encrypted credential reveal restricted, audited, excluded from caching and automatically hidden. Surface credential controls only inside an intentional detail section.

## Repairs and activity

Implement a private manager-entered repair queue linked to an asset and optionally a desk/location. Record the issue, priority, responsible party, opened time, due time, notes and resolution. Begin with New, In progress, Waiting, Resolved and Cancelled; define reopening and state transitions. Resolve a repair with an explicit resulting asset condition/lifecycle rather than silently marking every item good.

Show overdue, due soon and waiting views with consistent date/timezone behavior. Keep facilities-wide requests, procurement, vendor portals, floor plans, QR scanning and automated recurring emails outside the initial scope. Photos or imports can follow only if they support a confirmed workflow and have proper validation and access control.

Activity should provide a searchable record of asset creation, assignment, return, transfer, condition changes, repair resolution and retirement, with actor, time and relevant before/after values. Never log credentials. Prefer retirement/archive to routine hard deletion so custody history remains meaningful. Follow existing audit retention conventions.

## Migration and integrity

Prepare compatible SQLite and PostgreSQL migrations using repository conventions. Preserve all records, IDs and encrypted data. Backfill asset tags deterministically and collision-safely. Treat ambiguous product, location, desk and custodian mappings as Needs review; do not auto-merge assets or claim physical verification. Provide a review report and a reversible deployment/backfill plan with checks for record counts and orphaned relationships.

The reviewed database showed 227 items and no recorded desk/holder assignments. Do not hard-code those counts: measure the current database and reconcile it before and after migration. Correct the existing needs-attention mismatch so both NEEDS_REPAIR and BROKEN appear when that metric is selected. Replace lexical numbered-name ordering with a defined natural sort. Preserve filters and form input through save/error flows.

If exports are included, distinguish filtered results from all records, enforce the same permission scope, exclude credentials and neutralize spreadsheet formula injection. If import is included later, provide a dry-run preview, duplicate detection and row-specific validation before committing.

## Verification and delivery

Implement in coherent phases: (1) navigation/usability and existing logic fixes, (2) linked records and custody integrity, (3) repairs and activity. Keep each phase functional and reviewable.

Test meaningful business cases: manager-only access, impersonation rejection, tenant isolation, direct endpoint authorization, metrics matching filters, broken/unassigned availability, unique tags, atomic assignment/return/transfer, duplicate assignment prevention, stale edits, repair closure/reopening and preservation of credentials. Run relevant existing Office and My Desk/setup tests, plus repository lint, template validation and migration checks appropriate to the change.

Verify in the browser at desktop and narrow mobile widths in both themes. Exercise searching, combined filters, pagination, Back/Forward, opening/cancelling forms, validation errors, assigning/returning an asset and logging/resolving a repair using isolated test data. Confirm sticky controls do not obscure keyboard focus. Do not alter real inventory merely to generate a screenshot.

Acceptance: the manager can find inventory without scrolling past summary/product/add sections; linked desk and inventory views agree; unavailable assets cannot be silently assigned; historical custody remains visible; existing My Desk/setup behavior works; no record or credential is lost; all displayed metrics have documented, testable meanings. Proposed usability targets are finding a known asset within 10 seconds and completing a normal assignment within 30 seconds, to be evaluated with representative tasks rather than claimed without measurement.

Deliver changed files, migration/backfill instructions, screenshots, exact validation results, remaining limitations and decisions requiring owner input. Do not mark this complete solely because the page looks different.
