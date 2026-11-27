# GOID V2 database rollout

## Important status

The website redesign is being prepared on the `goid-redesign` pull-request branch. The live GitHub Pages site remains on `main`. These SQL files have **not** been run against the live Supabase project by this repository change.

## Protect the existing project first

1. Download a ZIP of the current GitHub repository and keep it privately.
2. In Supabase, export the existing public tables before applying the committed migration. At minimum export `profiles`, `opportunities`, `bookmarks`, `assistance_requests`, `opportunity_revisions`, `opportunity_reports`, `site_feedback`, `activity_log`, `goid_user_preferences`, and `app_settings`. These exports contain personal or account-related information; store them securely.
3. Record the row counts for those tables. Do not delete accounts, reset Auth, drop tables, or recreate the Supabase project.
4. Confirm the project is active and that the correct Supabase project is open before running SQL.

## Run order

1. Run `GOID_V2_DRY_RUN.sql` first. It is a rollback-only rehearsal and must finish with its `ROLLBACK` statement. Check the returned row counts against your recorded counts.
2. Only after a recoverable export is saved and the dry run succeeds, run `GOID_V2_ADDITIVE_MIGRATION.sql` once.
3. Confirm that the original row counts remain unchanged and that `goid_notifications` now exists. The migration adds profile/review metadata, private profile-photo storage, notification infrastructure, access policies, RPCs, triggers, and realtime publication membership.
4. Test login and all three roles before changing the GitHub Pages publishing source or merging the pull request.

## Preservation and deletion safeguards

- The migration does not drop tables or columns and does not delete existing users, opportunities, bookmarks, assistance requests, revisions, reports, feedback, or activity-log rows.
- Legacy assessment columns, `evidence`, and `app_settings` are retained for history/rollback. The V2 frontend no longer displays or calculates weighted assessment scores or strategic decision labels.
- The record-update RPC deliberately does not overwrite the legacy `evidence` field when an existing opportunity is edited. Existing evidence is also no longer validated as a condition of submission or review.
- A separately invoked Admin-only archive/delete RPC supports the Archived workflow. Permanent deletion is blocked while related bookmarks, assistance requests, reports, or revisions exist. The migration itself does not invoke that delete action.
- The legacy scoring-settings RPC is retained for rollback compatibility; the V2 frontend does not expose or call it.
- Never put a Supabase service-role key or SMTP password in GitHub. `config.js` must contain only the public publishable key.

## Required post-migration tests

- Student: sign in, complete preferences, browse all opportunities, view Top 3 and Top 10, save, compare up to three, request assistance, report an issue, edit profile/avatar, and mark notifications read.
- Staff: submit a listing, see only own pending/returned tasks, propose an edit to a verified listing, claim/respond to assistance, review reports/feedback, and request archiving.
- Admin: approve/return/reject submissions, approve/return/reject proposed edits, manage roles and active status, archive/restore/delete with dependency checks, inspect activity logs, and review descriptive analytics.
- Confirm that archived and demo opportunities do not appear in student discovery; do not delete demo rows as part of this UI deployment.
- Confirm that profile photos are private and readable only by the owner, Admin, or Staff assigned to the relevant assistance request.

Do not merge/deploy until the migration is confirmed successful and these role-based checks pass.


## Official campus/college directory

The registration and profile selectors use the campus and college combinations listed by New Era University's official [Academics page](https://neu.edu.ph/main/academics), cross-checked with the official [Pampanga](https://neu.edu.ph/main/campus/pampanga), [Lipa](https://neu.edu.ph/main/campus/lipa), [General Santos](https://neu.edu.ph/main/campus/gen-san), and [Rizal](https://neu.edu.ph/main/campus/rizal) branch pages. The General Santos branch page currently lists College of Accountancy and College of Business Administration; Rizal's listed college offering is College of Agriculture. The application and database validate the selected college against the selected campus. Legacy college labels are accepted only for existing profiles so users can review and update their records without losing the old value.
