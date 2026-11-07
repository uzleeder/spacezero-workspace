# Office Management

Private workspace for the office manager (`Profile.officeManager`, currently Fred Marco). It has five tabs: Overview, Assets, Desks, Repairs and Activity. There is no employee request portal. Employees only see their own **My PC** on their Setup page and profile.

## Access

- Every Office page, change and detail request goes through `onlyOfficeManager` in `routes/office.js`. The person must be the office manager and must not be in an Admin's "View as" session. Every query is scoped to their own organization.
- Anyone else, Admins and Supervisors included, gets *Not found*. While an Admin is viewing as someone, changes are already refused (403) by the app's read-only guard.
- The **Office Management** sidebar entry, and the button on the Dashboard and Profile, are shown to the office manager only.
- My PC (`/my/desk`, `/my/desk/password`) works as before: a person sees only their own desk, never while being viewed as.

## Assets: what each word means

These definitions are used both for the Overview numbers and for the Assets list each number opens (`VIEWS` in `lib/office.js`), so a count always matches its list.

| Name | Meaning |
| --- | --- |
| All in service | not retired |
| Assigned | not retired, and with a person **or** at a desk (never both) |
| Unassigned | not retired, not with a person and not at a desk |
| Confirmed available | unassigned **and** in service **and** condition Good **and** physically checked **and** nothing left to review. *Unassigned is not the same as available.* |
| Needs repair or broken | not retired, condition Needs repair **or** Broken. Both are counted and listed; this fixes the old count that linked to Needs repair only. |
| Under repair | lifecycle In repair (an open repair) |
| Needs review | not retired, and marked for review, or missing a model or a location |
| Retired | taken out of service; kept with its history instead of being deleted |

Each asset has a stable asset tag (`SZ-0001`, unique per organization, never reused or restarted), its own name, an optional model/product, a category, a location, a condition (Good / Needs repair / Broken) and a lifecycle (In service / In repair / Retired). Condition, lifecycle and custody are separate. Lists sort in natural order (2 before 10).

### Custody rules

Each custody change is one transaction together with its Activity row:

- **Give to a person / place at a desk:** only in-service, Good assets. The person must be an active member of the organization; the desk must belong to the organization. An asset is never held by a person and a desk at once; moving from one to the other is a transfer.
- **Return:** clears the person/desk and records where it went (for example Storage).
- **Retire:** needs a reason. Not allowed while a repair is open. Returns the asset from whoever had it. **Restore** puts it back in service, still to be checked.
- **Conflict check:** every edit carries the record's version. A save made after someone else changed the record is refused with "Someone else changed this record…", and nothing is overwritten.

## Desks

- **What a desk holds:** number, team label, who sits there (a person or a written name), linked assets, the older written equipment notes, the computer password and a note. Written notes stay as written until the manager links real assets; they are never matched automatically.
- **Ready:** occupied, with a computer or computer case, a monitor and headphones linked (none retired). **Not ready:** occupied but missing one of those. **Unoccupied:** no person and no written name.
- **Password security:** the computer password is encrypted (bound to the desk ID, so desk IDs never change). It is only shown on request, audited, never cached, and hidden again after 20 s. It only appears in the desk's own "Computer password" section.
- **Changing who sits at a desk:**
  - When the office manager changes the person, the saved password is **removed** unless they tick "keep the saved PC password". Linked equipment stays with the desk.
  - When an employee claims a free desk on their Setup page, that desk's previously saved password is **not** passed on; they enter their own.
- **Removing a desk:** only possible when no assets are linked to it.

## Repairs

A private queue for equipment and furniture. Each repair is linked to one asset and records the problem, priority, who is handling it, the opening date, due date, notes and resolution.

| From | Allowed moves |
| --- | --- |
| New | In progress, Waiting, Resolved, Cancelled |
| In progress | Waiting, Resolved, Cancelled |
| Waiting | In progress, Resolved, Cancelled |
| Resolved / Cancelled | Reopen (to In progress) |

What each step does to the asset:

- **Opening** puts the asset In repair, with the condition the manager reports (Needs repair or Broken). Only one repair per asset can be open at a time.
- **Resolving** requires the asset's resulting condition **and** whether it stays in service or is retired. Nothing is marked Good automatically.
- **Cancelling** puts the asset back in service (if no other repair is open) without changing its condition.
- **Reopening** puts the asset back In repair.

**Due dates:** due dates are whole days in Tashkent time (UTC+05:00): "due 12 Nov" means by the end of 12 Nov there. *Overdue* = open and past due. *Due soon* = open and due within 3 days.

## Activity

Every change to an asset, desk or repair: who, when, what, and the before/after values of the changed fields. It is written in the same transaction as the change and never contains a password. Search by asset tag, item, desk or person, and filter by kind of change.

## Migration and backfill

1. **Back up** the database.
2. **Apply the migrations** with the usual commands (`npm run db:migrate` for SQLite, `npm run db:migrate:production` for PostgreSQL). `20261106120000_office_records` only adds columns and two tables. Every existing item, desk, desk ID and encrypted password is kept.
3. **Generate the client:** `npx prisma generate`.
4. **Existing items without asset tags** (records created before this migration):
   - Run a dry run first: `node scripts/office-backfill.cjs`. It prints record counts, items pointing at a missing person or desk, duplicate tags, and the planned changes.
   - Then apply: `node scripts/office-backfill.cjs --apply`. It writes `office-backfill-report-<time>.json` and checks that the record count is unchanged.
   - What it changes:
     - Tags are given oldest first, after the highest existing tag.
     - A model and category are filled in only where the name is exactly a product from `scripts/office-inventory.cjs`, or that product followed by a number (for example "Mouse 7").
     - Everything else is marked *Needs review*.
     - Locations, custody, condition and physical checks are not touched. Records stay "Needs review" or "not checked" until the manager confirms them.
   - **To undo:** `node scripts/office-backfill.cjs --revert office-backfill-report-<time>.json`.
5. **A new database** with no office items: `node scripts/office-seed.cjs` loads the handed-over list with tags, models and categories, all in Storage and not yet checked.

## Not included (on purpose)

- employee request portal
- facilities-wide requests (electricity, cleaning)
- procurement or vendor portals
- floor plans
- QR scanning
- automatic emails or recurring reminders
- import/export
- photos
- a one-desk-per-person rule (the desk practice still needs confirming)

## Tests

`tests/officeManagement.test.js` covers:

- **Access and isolation:** manager-only access, "View as", other organizations, and direct requests to every endpoint.
- **Assets:** tags and the add preview, natural order, filters and pages, keeping the typed form after an error, Overview numbers matching their lists, broken items not being assignable.
- **Custody:** atomic assign/transfer/return with history, refusing stale edits.
- **Desks:** readiness, password rules on a change of occupant.
- **Repairs:** every state move and its effect on the asset.
- **Activity and backfill:** activity search without passwords, backfill dry run / apply / revert.
- **My PC:** the existing My PC flows.
