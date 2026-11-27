# GOID consolidated dashboard upgrade
The existing login screen, repository and Supabase project are retained. The new dashboard branch depends on the V3 onboarding and archive-decision migration. Do not merge before the database upgrade and verification.

1. Record the current database inventory (including notifications).
2. Run GOID_V3_ONBOARDING_DRY_RUN.sql as a complete transaction. It ends in ROLLBACK. All 13 protected table fingerprints must match.
3. Prefer a recoverable database backup. Run GOID_V3_ONBOARDING_MIGRATION.sql only if the dry run succeeded. It has the same body and ends in COMMIT.
4. Run the read-only checks below. Then merge after automated and browser validation.

```sql
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='goid_profile_version') AS profile_version_ready,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='goid_preferences_version') AS preference_version_ready,
  to_regprocedure('public.goid_complete_profile_v3(jsonb)') IS NOT NULL AS profile_rpc_ready,
  to_regprocedure('public.goid_save_preferences_v3(jsonb)') IS NOT NULL AS preference_rpc_ready,
  to_regprocedure('public.goid_decide_archive_v3(uuid,text,text)') IS NOT NULL AS archive_rpc_ready,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='opportunity_reports' AND column_name='archive_requested') AS archive_marker_ready;
```

Existing accounts must complete structured profiles once; User accounts also review all 11 preferences. New complete registrations skip redundant profile review. The setup gate applies to normal portal navigation; existing backend role restrictions remain unchanged. Completion flags persist across devices; unfinished survey and opportunity drafts remain local to the current browser. Existing saved answers are not overwritten until a user explicitly submits the complete updated questionnaire. No new account or credential is created for existing users. No Preference is neutral for the applicable matching dimensions.
