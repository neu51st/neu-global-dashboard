-- GOID V3 guarded onboarding upgrade. Run the dry run first. Existing original columns are fingerprinted.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Preservation guard: lock existing records against concurrent writes during the upgrade.
-- Only fingerprints and counts of original columns are stored in a transaction-local table.
LOCK TABLE auth.users, auth.identities,
 public.profiles, public.opportunities, public.bookmarks,
 public.assistance_requests, public.opportunity_revisions, public.opportunity_reports,
 public.site_feedback, public.activity_log, public.goid_user_preferences,
 public.app_settings, public.goid_notifications IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE goid_v2_preservation_guard (
 schema_name text NOT NULL, table_name text NOT NULL,
 original_columns text NOT NULL, row_count bigint NOT NULL, fingerprint text NOT NULL,
 PRIMARY KEY (schema_name, table_name)
) ON COMMIT DROP;
DO $goid_guard_snapshot$
DECLARE t record; cols text; n bigint; digest text;
BEGIN
 FOR t IN SELECT * FROM (VALUES
 ('auth','users'),('auth','identities'),
 ('public','profiles'),('public','opportunities'),('public','bookmarks'),
 ('public','assistance_requests'),('public','opportunity_revisions'),
 ('public','opportunity_reports'),('public','site_feedback'),
 ('public','activity_log'),('public','goid_user_preferences'),
 ('public','app_settings'),('public','goid_notifications')) AS protected(schema_name,table_name)
 LOOP
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
   INTO cols FROM pg_catalog.pg_attribute
   WHERE attrelid=to_regclass(format('%I.%I',t.schema_name,t.table_name))
   AND attnum>0 AND NOT attisdropped;
  IF cols IS NULL THEN RAISE EXCEPTION 'Missing protected table %.%',t.schema_name,t.table_name; END IF;
  EXECUTE format($q$SELECT count(*), md5(coalesce(string_agg(h, ',' ORDER BY h), ''))
   FROM (SELECT md5(to_jsonb(x)::text) AS h FROM (SELECT %s FROM %I.%I) x) hashed$q$,
   cols,t.schema_name,t.table_name) INTO n,digest;
  INSERT INTO pg_temp.goid_v2_preservation_guard VALUES(t.schema_name,t.table_name,cols,n,digest);
 END LOOP;
END
$goid_guard_snapshot$;

-- Add version markers without replacing any existing account data.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS goid_profile_version integer NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS goid_preferences_version integer NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION public.goid_new_profile_version_v3() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 NEW.goid_profile_version:=0;
 NEW.goid_preferences_version:=0;
 IF NEW.role='student' AND nullif(btrim(NEW.first_name),'') IS NOT NULL AND nullif(btrim(NEW.last_name),'') IS NOT NULL
 AND public.goid_valid_college(NEW.campus,NEW.college) AND nullif(btrim(NEW.year_level),'') IS NOT NULL
 AND nullif(btrim(NEW.affiliation),'') IS NOT NULL AND NEW.privacy_acknowledged_at IS NOT NULL THEN
 NEW.goid_profile_version:=1;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS goid_new_profile_version_v3_trigger ON public.profiles;
CREATE TRIGGER goid_new_profile_version_v3_trigger BEFORE INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.goid_new_profile_version_v3();
CREATE OR REPLACE FUNCTION public.goid_complete_profile_v3(p_fields jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF coalesce(public.neu_role(),'')='' THEN RAISE EXCEPTION 'Active account required' USING ERRCODE='42501'; END IF;
 PERFORM public.goid_update_profile(p_fields);
 UPDATE public.profiles SET goid_profile_version=1 WHERE id=auth.uid();
END $$;
CREATE OR REPLACE FUNCTION public.goid_save_preferences_v3(p_answers jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE k text; choices jsonb; a jsonb; allowed jsonb:='{"users":["Student","Educator","Researcher","Industry Professional","Entrepreneur / MSME Owner","Community Member"],"categories":["Academic Internationalization","Research Internationalization","Business/Industry Internationalization","Community/MSME Internationalization","No Preference"],"types":["Scholarships","Training","Internships","Research Grants","Exchange Programs","Partnerships","Business Funding","Trade / Export Programs","Community Development","No Preference"],"countries":["Philippines","Japan","South Korea","Singapore","Malaysia","Thailand","No Preference"],"funding_coverage":["Fully Funded","Partially Funded","Self-Funded","No Preference"],"expenses":["Registration / Application Fees","Travel","Accommodation","Other Participation Costs","None — I need support"],"benefits":["Financial Assistance","Skills Development","Research Support","Career Experience","Networking","Business Growth","International Exposure","No Preference"],"formats":["Online","Face-to-Face","Hybrid","No Preference"],"documents":["Academic Records","Resume / CV","Portfolio / Proposal","Recommendation Letters","English Proficiency Proof","Passport","None Yet"],"methods":["Direct Application","School / Organization Nomination","Invitation-Based","Not Sure Yet"]}'::jsonb;
BEGIN
 IF public.neu_role() IS DISTINCT FROM 'student' THEN RAISE EXCEPTION 'User account required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND goid_profile_version>=1) THEN RAISE EXCEPTION 'Complete your profile first'; END IF;
 IF jsonb_typeof(p_answers) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid preferences'; END IF;
 FOR k,choices IN SELECT key,value FROM jsonb_each(allowed) LOOP
  a:=p_answers->k;
  IF jsonb_typeof(a) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Complete preference: %',k; END IF;
  IF jsonb_array_length(a)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(a) v WHERE NOT (choices @> jsonb_build_array(v))) THEN RAISE EXCEPTION 'Invalid preference: %',k; END IF;
  IF jsonb_array_length(a)>1 AND (a ?| ARRAY['None Yet','None — I need support','Not Sure Yet','No Preference']) THEN RAISE EXCEPTION 'Choose the exclusive option alone: %',k; END IF;
 END LOOP;
 IF coalesce(p_answers->>'timeline','') NOT IN ('As Soon As Possible','Within 3 Months','Within 6 Months','Just Exploring') THEN RAISE EXCEPTION 'Choose an application timeline'; END IF;
 INSERT INTO public.goid_user_preferences(user_id,answers,updated_at) VALUES(auth.uid(),p_answers,now())
 ON CONFLICT(user_id) DO UPDATE SET answers=public.goid_user_preferences.answers||excluded.answers,updated_at=excluded.updated_at;
 UPDATE public.profiles SET goid_preferences_version=1 WHERE id=auth.uid();
END $$;
REVOKE ALL ON FUNCTION public.goid_new_profile_version_v3() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.goid_complete_profile_v3(jsonb),public.goid_save_preferences_v3(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.goid_complete_profile_v3(jsonb),public.goid_save_preferences_v3(jsonb) TO authenticated;
CREATE INDEX IF NOT EXISTS goid_activity_created_v3_idx ON public.activity_log(created_at DESC);

-- Archive decisions are administrator-only and recorded separately from ordinary report review.
ALTER TABLE public.opportunity_reports ADD COLUMN IF NOT EXISTS archive_decision text,
 ADD COLUMN IF NOT EXISTS archive_decision_note text,
 ADD COLUMN IF NOT EXISTS archive_requested boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION public.goid_request_archive(p_id uuid,p_note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $goid_request_archive$
BEGIN
 IF coalesce(public.neu_role(),'') NOT IN ('staff','admin') THEN RAISE EXCEPTION 'Staff required' USING ERRCODE='42501'; END IF;
 IF nullif(btrim(p_note),'') IS NULL THEN RAISE EXCEPTION 'Reason required'; END IF;
 INSERT INTO public.opportunity_reports(opportunity_id,user_id,issue_type,description,archive_requested) VALUES(p_id,auth.uid(),'Other',left('Archive request: '||p_note,1000),true);
END $goid_request_archive$;
CREATE OR REPLACE FUNCTION public.goid_archive_decision_guard_v3() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $goid_archive_decision_guard_v3$
BEGIN
 IF current_user IN ('anon','authenticated') THEN
  IF TG_OP='INSERT' THEN
   IF NEW.archive_requested OR NEW.archive_decision IS NOT NULL OR NEW.archive_decision_note IS NOT NULL THEN RAISE EXCEPTION 'Use the authorized archive decision function' USING ERRCODE='42501'; END IF;
  ELSE
   IF NEW.archive_requested IS DISTINCT FROM OLD.archive_requested OR NEW.archive_decision IS DISTINCT FROM OLD.archive_decision OR NEW.archive_decision_note IS DISTINCT FROM OLD.archive_decision_note THEN RAISE EXCEPTION 'Use the authorized archive decision function' USING ERRCODE='42501'; END IF;
   IF (OLD.archive_requested OR (OLD.issue_type='Other' AND OLD.description LIKE 'Archive request: %' AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=OLD.user_id AND p.role IN ('staff','admin')))) AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'Use the authorized archive decision function' USING ERRCODE='42501'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $goid_archive_decision_guard_v3$;
DROP TRIGGER IF EXISTS goid_archive_decision_guard_v3_trigger ON public.opportunity_reports;
CREATE TRIGGER goid_archive_decision_guard_v3_trigger BEFORE INSERT OR UPDATE ON public.opportunity_reports FOR EACH ROW EXECUTE FUNCTION public.goid_archive_decision_guard_v3();
CREATE OR REPLACE FUNCTION public.goid_decide_archive_v3(p_report uuid,p_decision text,p_note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $goid_decide_archive_v3$
DECLARE r public.opportunity_reports%ROWTYPE;
BEGIN
 IF public.neu_role() IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF p_decision IS NULL OR p_decision NOT IN ('approve','reject') OR nullif(btrim(p_note),'') IS NULL THEN RAISE EXCEPTION 'Choose a decision and provide a note'; END IF;
 SELECT * INTO r FROM public.opportunity_reports WHERE id=p_report FOR UPDATE;
 IF NOT FOUND OR r.status<>'OPEN' OR NOT (r.archive_requested OR (r.issue_type='Other' AND r.description LIKE 'Archive request: %' AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=r.user_id AND p.role IN ('staff','admin')))) THEN RAISE EXCEPTION 'Open archive request not found'; END IF;
 IF p_decision='approve' THEN PERFORM public.goid_archive_opportunity(r.opportunity_id,'archive'); END IF;
 UPDATE public.opportunity_reports SET status='REVIEWED',archive_decision=CASE p_decision WHEN 'approve' THEN 'APPROVED' ELSE 'REJECTED' END,archive_decision_note=left(btrim(p_note),1000) WHERE id=p_report;
 INSERT INTO public.activity_log(actor_id,entity,entity_id,action,details) VALUES(auth.uid(),'opportunity',r.opportunity_id,upper(p_decision)||' ARCHIVE REQUEST',left(btrim(p_note),1000));
 PERFORM public.goid_emit(r.user_id,'archive_decision','Archive request decision',upper(p_decision)||' · '||left(btrim(p_note),300),'requests','archive-decision:'||p_report::text);
END $goid_decide_archive_v3$;
REVOKE ALL ON FUNCTION public.goid_archive_decision_guard_v3(),public.goid_decide_archive_v3(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.goid_decide_archive_v3(uuid,text,text) TO authenticated;

-- Compare original columns only, so newly added columns do not cause false mismatches.
-- A count or content mismatch aborts the entire transaction before COMMIT.
DO $goid_guard_verify$
DECLARE t record; n bigint; digest text;
BEGIN
 FOR t IN SELECT * FROM pg_temp.goid_v2_preservation_guard ORDER BY schema_name,table_name
 LOOP
  EXECUTE format($q$SELECT count(*), md5(coalesce(string_agg(h, ',' ORDER BY h), ''))
   FROM (SELECT md5(to_jsonb(x)::text) AS h FROM (SELECT %s FROM %I.%I) x) hashed$q$,
   t.original_columns,t.schema_name,t.table_name) INTO n,digest;
  IF n IS DISTINCT FROM t.row_count OR digest IS DISTINCT FROM t.fingerprint THEN
   RAISE EXCEPTION 'Data preservation check FAILED for %.% (before %, after %). Transaction must roll back.',
   t.schema_name,t.table_name,t.row_count,n;
  END IF;
  RAISE NOTICE 'Preserved %.%: % records',t.schema_name,t.table_name,n;
 END LOOP;
 RAISE NOTICE 'All 13 protected tables passed row-count and original-content checks.';
END
$goid_guard_verify$;
SELECT schema_name, table_name, row_count AS protected_rows,
 'Original records unchanged' AS preservation_result
 FROM pg_temp.goid_v2_preservation_guard ORDER BY schema_name,table_name;

ROLLBACK;
