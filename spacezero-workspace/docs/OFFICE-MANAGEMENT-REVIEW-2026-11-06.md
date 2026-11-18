# SpaceZero Office Management — review and discussion

Date: 6 November 2026. Scope: localhost `/office`, its Express/EJS implementation, Prisma models and existing Office tests. This is a design and source review, not a completed regression test or physical inventory audit.

## Confirmed direction

The user has chosen **Office manager only**. Preserve the existing `profile.officeManager` permission and impersonation restriction. Do not open this workspace to employees, ordinary supervisors or administrators. Existing employee My Desk functionality remains separate and must keep working; this proposal does not introduce an employee request portal.

## What the current page tells us

The live session showed 227 inventory items, zero recorded holders, zero desks and zero recorded repair/broken items. Of the items, 132 were categorized as Other. These are database observations, not proof of actual stock availability or physical condition.

At the observed 720px viewport height, the search toolbar began approximately 1,406px below the viewport top. The document was approximately 13,653px tall and rendered all 227 inventory rows. The first screen used a clear light palette and readable summary cards, but product cards, desks and a full add form appeared before inventory search. Office Management was absent from the visible sidebar.

| Finding | Consequence | Recommended change |
| --- | --- | --- |
| Search and daily actions are far below the page heading | Repeated scrolling for ordinary work | Put search, filters and the main action above a paginated asset table |
| One page combines summaries, product cards, desks, forms and all assets | The manager must navigate around unrelated tasks | Separate Overview, Assets, Desks, Repairs and Activity |
| A null holder is counted as “In the office” | Unassigned, available, stored and broken items can be confused | Separate custody, location, condition and lifecycle; label unverified records honestly |
| Desk components are text, independent of inventory items | Desk and equipment records can contradict each other | Link desks to real asset records and use one assignment workflow |
| “Need repair / broken” counts both conditions but links only to NEEDS_REPAIR | Clicking a count can omit broken equipment | Use the same predicate for the metric and destination list |
| Product groups are inferred by stripping trailing numbers | A legitimate model number can disappear | Add explicit product/model identity; review ambiguous legacy mappings |
| Bulk creation restarts item numbering; display sorting is lexical | Names are unreliable identifiers; 10 appears before 2 | Stable unique asset tags and natural display sorting |
| Save redirects reset the list; validation redirects lose input | Editing interrupts the manager’s working context | Preserve filters, pagination, position and submitted values |
| Deletes are hard deletes using browser confirmation | Useful custody information can disappear | Prefer retirement/archive with an in-page confirmation and retained history |
| Desk table includes credential controls among ordinary inventory fields | Sensitive actions compete with routine work | Put credential access in an explicitly opened, permission-checked detail section |

## Architecture findings

`OfficeItem` currently records a name, type, holder, condition and note. It has no explicit asset tag, model, physical location, desk link or custody history. `OfficeDesk` stores equipment descriptions independently. This is the central structural limitation: a more attractive table alone cannot make assignments trustworthy.

Preserve existing positive safeguards: tenant scoping, the Office Manager gate, rejection of impersonated sessions, encrypted desk credentials, authorized audited reveal and automatic hiding. Keep desk IDs stable because credential encryption uses desk-specific associated data.

The employee desk-claim path deserves a focused review before connecting inventory: claiming an unassigned desk can inherit its existing desk record. Do not let a proposed linkage unintentionally broaden credential visibility. New assignments should validate eligible active profiles while retaining historical references to former employees. Assignment changes and movement history should commit atomically.

Evidence locations: `routes/office.js`, `lib/office.js`, `lib/officeDesks.js`, `views/office/index.ejs`, `views/partials/office-desk-form.ejs`, Office CSS, both Prisma schemas and `tests/officeManagement.test.js`. Tests were inspected; no new regression results are claimed by this review.

## Research and how it applies

- [IBM Carbon data table guidelines](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines): use a consistent toolbar, search/filter controls, row details, selection actions and pagination. Application: one working asset table with contextual actions rather than many permanent forms.
- [Nielsen Norman Group: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/): keep frequent tasks immediately accessible and expose secondary complexity when needed. Application: Add/Edit and advanced filters open on demand; summaries stop pushing the working area down.
- [Snipe-IT asset-management overview](https://snipe-it.readme.io/docs/overview): distinguish unique physical assets, custody through checkout/check-in, and lifecycle/status. Application: introduce reliable asset identity and assignment history instead of deriving identity from names.
- [Atlassian service-management queues](https://support.atlassian.com/jira-service-management-cloud/docs/check-out-your-queues/) and [service request management](https://www.atlassian.com/itsm/service-request-management): organize work around intake, ownership, state and completion. Application: a private manager-entered repair queue; no employee portal is required.
- [W3C focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) and [target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum): sticky UI must not hide keyboard focus, and controls need adequate size or spacing. Application: test header offsets and focus visibility; aim for comfortable 40–44px actions while recognizing the WCAG minimum criterion is 24px with exceptions.

These sources support the design principles. The proposed SpaceZero structure below is a recommendation derived from this review, not a claim that a vendor prescribes this exact implementation.

## Proposed structure

```text
Office Management                           + Add asset
Overview | Assets | Desks | Repairs | Activity

Assets
Search assets…   Status   Category   Location   More filters
Active filter chips                       227 results
Select | Asset tag | Item/model | Person/desk | Location | Status
… 25 rows …
Selected-item actions                      Pagination
```

Overview should prioritize unresolved repairs, overdue repair follow-ups and incomplete records. Assets should be the primary daily working surface. Desks should show occupancy and linked equipment without a floor-plan editor. Repairs should support manager-created issues, ownership, due dates and resolution. Activity should answer who changed custody, condition or location and when.

Use the existing SpaceZero typography, warm accent and theme tokens. Keep light mode neutral and legible, dark mode layered and distinct, tables compact, and status labels explicit. Avoid adding ornamental charts before there is trustworthy history to chart.

## Delivery order

1. **Daily usability and correctness:** navigation, top toolbar, pagination, filter persistence, count/filter fixes, natural sorting, in-page dialogs and visible data-quality labels.
2. **Reliable records:** stable asset tags, reviewed categories/models, physical locations, linked desks, transaction-safe assignments, returns and movement history. Preserve all legacy records and credential ciphertext.
3. **Private service workflow:** manager-entered repairs, due dates, resolution and activity. Add import/export only with clear scope and validation. Automated email and recurring reminders need a separately defined policy; do not copy the training reminder schedule into Office.

## Discussion before implementation

The manager-only decision is settled. Two remaining product choices are worth discussing:

1. Should Repairs initially cover equipment only, or also facilities issues such as furniture, electricity and cleaning? Recommendation: equipment and furniture first, then facilities if the manager actually tracks that work.
2. Should one employee have one active desk or several? Recommendation: one primary desk plus explicitly recorded temporary assignments; validate this against actual office practice before enforcing a database constraint.

The accompanying implementation prompt is complete enough to hand to a coding agent, but remains a discussion draft. No Office implementation, data mutation, password change, email send or deployment was performed as part of this review.
