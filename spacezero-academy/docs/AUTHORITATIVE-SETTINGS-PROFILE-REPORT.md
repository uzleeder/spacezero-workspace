# Authoritative Settings / Profile cleanup

This report supersedes the earlier Settings report where the earlier report retained General's quick catalogs.

## Delivered organization

- The dynamic account menu contains Profile & Settings and Log out; the notification bell remains separate.
- Profile & Settings reuses `/profile`, employee Setup, employee Leave and the existing password action. Its primary navigation is Profile, Setup, Vacation & Leave, Account & Security. Existing Training, Skills, Activity and authorized Credentials links remain under More profile tools.
- Organization Settings retains General / Security / Advanced. General is an honest overview, with no invented settings and no duplicate catalog forms.
- Tenure Bands now appears in Advanced → Development with compact rows, expandable add form and the existing Remove action with confirmation. No edit/deactivate behavior was invented.
- Advanced → Skills is the single Skill Catalog UI: real-data search, role/status filters, compact rows and expandable editors. No internal list scroll box or new catalog/model was introduced.
- Existing Advanced groups, breadcrumbs and operational cross-links remain.

## Authoritative sources and dependencies

| Configuration | Source and operational connection |
| --- | --- |
| Tenure | Existing `TenureBand` records. `lib/profileOverview.js` loads them and `lib/tenure.js` resolves the employee's stage from their employment start date. No separate automation dependency on these records was found; Development's existing date-based rules remain unchanged. |
| Skills | Existing `Skill` records, related `EmployeeSkill` rows and evidence/scoring consumers. The old General form and Advanced form wrote the same model; their duplicate UI was consolidated. Existing role-specific definitions remain separate records, even where names match. |
| Setup | Existing SetupRequirement, target and EmployeeSetupItem records consumed by employee Setup and readiness calculations. |
| Supervisor permissions / System Access | Existing SupervisorCapability store and server-side checks. No grants, revocations or role assignments were performed on live accounts. |
| Training rules | Existing OrgSetting policy values, read by assignments, course audience, grading/scoring and retention. |
| Development | Existing development paths, assignment rules and recommendations consumed by onboarding/automation services. |
| Certifications | Existing definitions and earned records evaluated from courses, assessments and skill evidence. |
| Standards | Existing versioned StandardsItem/content and the operational Standards pages. |
| Audit | Existing organization-scoped AuditLog events. |

No disconnected replacement configuration source was created. No uncertain data or historical records were removed. Repeated skill names across roles are not assumed to be duplicates. Legacy mutation URLs remain for compatibility; moved tenure/skill actions are guarded by the existing System Configuration Access check as part of their placement in Advanced. This changes their former General-only route exposure without changing any stored access assignments.

## Additional Admin Setup correction requested during this work

Previously, employee-confirmed manual requirements in In Progress appeared in the large exceptions section; Save retained In Progress unless the Admin changed the status explicitly. They now appear in the Admin compact checklist with a clear verification hint. Selecting them and saving uses the existing audited verification fields. Unselected pending items stay pending, so saving a different checkbox cannot withdraw an employee's confirmation. Company-controlled and automatically calculated requirements retain their existing dedicated checks. A Verify & complete shortcut also uses the existing individual status endpoint. Duplicate verification explanations were removed.

The Setup adjustment is an explicit follow-up requested by the user, separate from the Settings-only UX cleanup. No real employee requirements were bulk-completed during testing.

## Verification

Browser checks confirmed personal navigation, the separate account-security form, Skill Catalog search and the moved Tenure Bands heading. Integration tests cover missing Advanced access on legacy URLs, role boundaries, invalid-form preservation, Admin verification persistence and pending-item preservation. Test databases are isolated from live data.

Final regression result is recorded below after the completed run.

No live business configuration values, employee records, role assignments or permissions were intentionally changed during this UX/settings cleanup.
