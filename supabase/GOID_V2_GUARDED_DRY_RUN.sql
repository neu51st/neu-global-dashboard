-- GUARDED DRY RUN ONLY. Run as one complete query. Ends in ROLLBACK.
-- GOID coordinated upgrade. Run only after staging/testing and a recoverable backup.
-- Existing data, IDs, auth users, and legacy columns are retained.
-- All changes are transactional. A failed statement rolls the transaction back.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Preservation guard: lock existing records against concurrent writes during the upgrade.
-- Only fingerprints and counts of original columns are stored in a transaction-local table.
LOCK TABLE auth.users, auth.identities,
 public.profiles, public.opportunities, public.bookmarks,
 public.assistance_requests, public.opportunity_revisions, public.opportunity_reports,
 public.site_feedback, public.activity_log, public.goid_user_preferences,
 public.app_settings IN SHARE ROW EXCLUSIVE MODE;
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
 ('public','app_settings')) AS protected(schema_name,table_name)
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

DO $$ BEGIN
 IF to_regclass('public.profiles') IS NULL OR to_regclass('public.opportunities') IS NULL OR to_regclass('public.goid_user_preferences') IS NULL THEN RAISE EXCEPTION 'Wrong database or missing GOID schema'; END IF;
END $$;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS first_name text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS last_name text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS middle_initial text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS suffix text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS campus text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS affiliation text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS avatar_key text, ADD COLUMN IF NOT EXISTS photo_path text;
ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL, ADD COLUMN IF NOT EXISTS reviewed_at timestamptz, ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS review_checks jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.opportunities ALTER COLUMN evidence SET DEFAULT '{}'::jsonb;
ALTER TABLE public.opportunity_revisions ADD COLUMN IF NOT EXISTS review_checks jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.activity_log ADD COLUMN IF NOT EXISTS actor_name text, ADD COLUMN IF NOT EXISTS actor_role text;
ALTER TABLE public.assistance_requests ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.site_feedback ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'NEW';
ALTER TABLE public.site_feedback DROP CONSTRAINT IF EXISTS goid_feedback_status_check;
ALTER TABLE public.site_feedback ADD CONSTRAINT goid_feedback_status_check CHECK(status IN ('NEW','REVIEWED'));
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS goid_avatar_key_check;
ALTER TABLE public.profiles ADD CONSTRAINT goid_avatar_key_check CHECK(avatar_key IS NULL OR avatar_key IN ('avatar-1','avatar-2','avatar-3','avatar-4','avatar-5','avatar-6','avatar-7','avatar-8','avatar-9','avatar-10','avatar-11','avatar-12'));
ALTER TABLE public.opportunities DROP CONSTRAINT IF EXISTS opportunities_verification_check;
ALTER TABLE public.opportunities ADD CONSTRAINT opportunities_verification_check CHECK (verification IN ('PENDING VERIFICATION','VERIFIED','EXPIRED','ARCHIVED','RETURNED','REJECTED'));
ALTER TABLE public.opportunity_revisions DROP CONSTRAINT IF EXISTS opportunity_revisions_status_check;
ALTER TABLE public.opportunity_revisions ADD CONSTRAINT opportunity_revisions_status_check CHECK (status IN ('PENDING','APPROVED','REJECTED','RETURNED'));
CREATE TABLE IF NOT EXISTS public.goid_notifications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 kind text NOT NULL,title text NOT NULL,message text NOT NULL DEFAULT '',target text NOT NULL DEFAULT '',
 dedupe_key text,created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz,
 UNIQUE(recipient_id,dedupe_key)
);
CREATE INDEX IF NOT EXISTS goid_notifications_recipient_idx ON public.goid_notifications(recipient_id,created_at DESC);
ALTER TABLE public.goid_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.goid_notifications FROM anon, authenticated;
GRANT SELECT ON public.goid_notifications TO authenticated;
DROP POLICY IF EXISTS goid_notifications_own ON public.goid_notifications;
CREATE POLICY goid_notifications_own ON public.goid_notifications FOR SELECT TO authenticated USING (recipient_id=auth.uid() AND public.neu_role()<>'');
-- Private images; users may access their own images, administrators all, and staff only assigned requests.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('goid-profile-photos','goid-profile-photos',false,5242880,ARRAY['image/jpeg','image/png','image/webp']) ON CONFLICT(id) DO NOTHING;
CREATE OR REPLACE FUNCTION public.goid_can_read_photo(p_owner text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.neu_role()<>'' AND (p_owner=auth.uid()::text OR public.neu_role()='admin' OR (public.neu_role()='staff' AND EXISTS(SELECT 1 FROM public.assistance_requests a WHERE a.requester_id::text=p_owner AND a.assigned_to=auth.uid())));
$$;
DROP POLICY IF EXISTS goid_photo_read ON storage.objects;
CREATE POLICY goid_photo_read ON storage.objects FOR SELECT TO authenticated USING(bucket_id='goid-profile-photos' AND public.goid_can_read_photo((storage.foldername(name))[1]));
DROP POLICY IF EXISTS goid_photo_insert ON storage.objects;
CREATE POLICY goid_photo_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='goid-profile-photos' AND public.neu_role()<>'' AND (storage.foldername(name))[1]=auth.uid()::text);
DROP POLICY IF EXISTS goid_photo_delete ON storage.objects;
CREATE POLICY goid_photo_delete ON storage.objects FOR DELETE TO authenticated USING(bucket_id='goid-profile-photos' AND public.neu_role()<>'' AND (storage.foldername(name))[1]=auth.uid()::text);
CREATE OR REPLACE FUNCTION public.goid_valid_college(p_campus text,p_college text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS '
 SELECT coalesce(CASE p_campus
  WHEN ''Quezon City — Main Campus'' THEN p_college=ANY(ARRAY[''College of Accountancy'',''College of Arts and Sciences'',''College of Business Administration'',''College of Communication'',''College of Criminology'',''College of Education'',''College of Engineering & Architecture'',''College of Engineering and Architecture'',''College of Informatics & Computing Studies'',''College of Informatics and Computing Studies'',''College of Law'',''College of Medicine'',''College of Medical Technology'',''College of Midwifery'',''College of Music'',''College of Nursing'',''College of Physical Therapy'',''College of Respiratory Therapy'',''School of International Relations'',''School of Graduate Studies'',''Other / Not Applicable''])
  WHEN ''Pampanga Campus'' THEN p_college=ANY(ARRAY[''College of Arts and Sciences'',''College of Accountancy'',''College of Business Administration'',''College of Education'',''College of Informatics & Computing Studies'',''College of Informatics and Computing Studies'',''Other / Not Applicable''])
  WHEN ''Lipa Campus'' THEN p_college=ANY(ARRAY[''College of Accountancy'',''College of Business Administration'',''College of Education'',''College of Informatics & Computing Studies'',''College of Informatics and Computing Studies'',''Other / Not Applicable''])
  WHEN ''General Santos City Campus'' THEN p_college=ANY(ARRAY[''College of Accountancy'',''College of Business Administration'',''Other / Not Applicable''])
  WHEN ''Rizal Campus'' THEN p_college=ANY(ARRAY[''College of Agriculture'',''Other / Not Applicable''])
  ELSE false END,false)
';
-- Do not guess split names or campus for existing users. Let them complete their profile.
CREATE OR REPLACE FUNCTION public.neu_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE m jsonb:=coalesce(new.raw_user_meta_data,'{}'::jsonb); k text;
BEGIN
 k:=m->>'avatar_key'; IF k IS NOT NULL AND k NOT IN ('avatar-1','avatar-2','avatar-3','avatar-4','avatar-5','avatar-6','avatar-7','avatar-8','avatar-9','avatar-10','avatar-11','avatar-12') THEN k:=NULL; END IF;
 INSERT INTO public.profiles(id,email,display_name,role,active,college,year_level,contact_number,telegram_username,preferred_contact,privacy_acknowledged_at,first_name,last_name,middle_initial,suffix,campus,affiliation,avatar_key)
 VALUES(new.id,coalesce(new.email,''),left(coalesce(nullif(btrim(m->>'full_name'),''),nullif(split_part(coalesce(new.email,''),'@',1),''),'Explorer'),120),'student',true,left(coalesce(btrim(m->>'college'),''),120),left(coalesce(btrim(m->>'year_level'),''),40),left(coalesce(btrim(m->>'contact_number'),''),30),left(coalesce(btrim(m->>'telegram_username'),''),50),'Email',CASE WHEN m->>'privacy_acknowledged'='true' THEN now() ELSE null END,left(coalesce(btrim(m->>'first_name'),''),60),left(coalesce(btrim(m->>'last_name'),''),60),left(coalesce(btrim(m->>'middle_initial'),''),5),left(coalesce(btrim(m->>'suffix'),''),8),left(coalesce(btrim(m->>'campus'),''),100),left(coalesce(btrim(m->>'affiliation'),''),100),k) ON CONFLICT(id) DO NOTHING;
 RETURN new;
END $$;
-- User-editable profile fields are explicitly allowlisted; role and active remain administrator-only.
-- The V2 profile RPC validates campus/college; legacy self-updates remain narrowly compatible during rollout.
CREATE OR REPLACE FUNCTION public.goid_update_profile(p_fields jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.profiles%ROWTYPE; nm text;
BEGIN
 IF public.neu_role()='' THEN RAISE EXCEPTION 'Active account required' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM public.profiles WHERE id=auth.uid() FOR UPDATE;
 IF nullif(btrim(p_fields->>'first_name'),'') IS NULL OR nullif(btrim(p_fields->>'last_name'),'') IS NULL THEN RAISE EXCEPTION 'First and last name are required'; END IF;
 IF coalesce(p_fields->>'campus','') NOT IN ('Quezon City — Main Campus','Pampanga Campus','Lipa Campus','General Santos City Campus','Rizal Campus') THEN RAISE EXCEPTION 'Select a valid campus'; END IF;
 IF NOT public.goid_valid_college(p_fields->>'campus',p_fields->>'college') THEN RAISE EXCEPTION 'Select a college listed for the selected campus'; END IF;
 IF nullif(btrim(p_fields->>'college'),'') IS NULL OR nullif(btrim(p_fields->>'year_level'),'') IS NULL OR nullif(btrim(p_fields->>'affiliation'),'') IS NULL THEN RAISE EXCEPTION 'Complete academic information'; END IF;
 nm:=concat_ws(' ',nullif(btrim(p_fields->>'first_name'),''),nullif(btrim(p_fields->>'middle_initial'),''),nullif(btrim(p_fields->>'last_name'),''),nullif(btrim(p_fields->>'suffix'),''));
 IF length(nm)>120 THEN RAISE EXCEPTION 'Full name exceeds 120 characters'; END IF;
 UPDATE public.profiles SET first_name=left(btrim(p_fields->>'first_name'),60),last_name=left(btrim(p_fields->>'last_name'),60),middle_initial=left(coalesce(btrim(p_fields->>'middle_initial'),''),5),suffix=left(coalesce(btrim(p_fields->>'suffix'),''),8),display_name=nm,campus=left(btrim(p_fields->>'campus'),100),college=left(btrim(p_fields->>'college'),120),affiliation=left(btrim(p_fields->>'affiliation'),100),year_level=left(btrim(p_fields->>'year_level'),40),contact_number=left(coalesce(p_fields->>'contact_number',p.contact_number),30),telegram_username=left(coalesce(p_fields->>'telegram_username',p.telegram_username),50),preferred_contact=coalesce(p_fields->>'preferred_contact',p.preferred_contact),updated_at=now() WHERE id=auth.uid();
END $$;
CREATE OR REPLACE FUNCTION public.goid_update_photo(p_path text,p_avatar text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF public.neu_role()='' THEN RAISE EXCEPTION 'Active account required' USING ERRCODE='42501'; END IF;
 IF p_avatar IS NOT NULL AND p_avatar NOT IN ('avatar-1','avatar-2','avatar-3','avatar-4','avatar-5','avatar-6','avatar-7','avatar-8','avatar-9','avatar-10','avatar-11','avatar-12') THEN RAISE EXCEPTION 'Invalid avatar'; END IF;
 IF p_path IS NOT NULL AND (split_part(p_path,'/',1)<>auth.uid()::text OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='goid-profile-photos' AND name=p_path)) THEN RAISE EXCEPTION 'Invalid photo path'; END IF;
 IF p_path IS NOT NULL AND p_avatar IS NOT NULL THEN RAISE EXCEPTION 'Choose one photo or avatar'; END IF;
 UPDATE public.profiles SET photo_path=p_path,avatar_key=p_avatar,updated_at=now() WHERE id=auth.uid();
END $$;
-- A trigger protects sensitive profile attributes even if old column-level grants remain.
CREATE OR REPLACE FUNCTION public.goid_profile_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS '
BEGIN
 IF current_user IN (''authenticated'',''anon'') AND
   (to_jsonb(NEW)-ARRAY[''display_name'',''college'',''year_level'',''contact_number'',''telegram_username'',''preferred_contact'',''updated_at'']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY[''display_name'',''college'',''year_level'',''contact_number'',''telegram_username'',''preferred_contact'',''updated_at'']) THEN
   RAISE EXCEPTION ''Use the authorized profile or account management function.'' USING ERRCODE=''42501'';
 END IF;
 RETURN NEW;
END
';
DROP TRIGGER IF EXISTS goid_profile_guard_trigger ON public.profiles;
CREATE TRIGGER goid_profile_guard_trigger BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.goid_profile_guard();
-- Existing admin RPC retains role checks and self-protection.
CREATE OR REPLACE FUNCTION public.neu_log_opportunity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF tg_op='DELETE' THEN INSERT INTO public.activity_log(actor_id,entity,entity_id,action,details) VALUES(auth.uid(),'opportunity',old.id,'DELETED',left(old.title,200)); RETURN old; END IF;
 IF tg_op='INSERT' THEN INSERT INTO public.activity_log(actor_id,entity,entity_id,action,details) VALUES(auth.uid(),'opportunity',new.id,'SUBMITTED',left(new.title,200)); RETURN new; END IF;
 IF new.verification IS DISTINCT FROM old.verification THEN INSERT INTO public.activity_log(actor_id,entity,entity_id,action,details) VALUES(auth.uid(),'opportunity',new.id,'STATUS: '||new.verification,left(new.title||' · '||old.verification||' → '||new.verification||CASE WHEN new.review_note<>'' THEN ' · '||new.review_note ELSE '' END,1500));
 ELSE INSERT INTO public.activity_log(actor_id,entity,entity_id,action,details) VALUES(auth.uid(),'opportunity',new.id,'UPDATED',left(CASE WHEN old.title IS DISTINCT FROM new.title THEN old.title||' → '||new.title ELSE new.title END,500)); END IF;
 RETURN new;
END $$;
CREATE OR REPLACE FUNCTION public.goid_log_actor() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF new.actor_id IS NOT NULL THEN SELECT display_name,role INTO new.actor_name,new.actor_role FROM public.profiles WHERE id=new.actor_id; END IF;
 RETURN new;
END $$;
DROP TRIGGER IF EXISTS goid_log_actor_trigger ON public.activity_log;
CREATE TRIGGER goid_log_actor_trigger BEFORE INSERT ON public.activity_log FOR EACH ROW EXECUTE FUNCTION public.goid_log_actor();
-- The database, not the browser, authorizes submission/review transitions.
REVOKE INSERT, UPDATE, DELETE ON public.opportunities FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.opportunity_revisions FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.neu_review_revision(uuid,boolean,text,text) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.neu_guard_opportunity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF tg_op='INSERT' THEN
  IF auth.uid() IS NOT NULL THEN new.created_by=auth.uid();new.verification='PENDING VERIFICATION';new.archived=false;new.reviewer='';new.last_verified=NULL;new.reviewed_by=NULL;new.reviewed_at=NULL; END IF;
 ELSE new.created_by=old.created_by;new.created_at=old.created_at; END IF;
 new.is_demo=false;new.updated_at=now(); RETURN new;
END $$;
CREATE OR REPLACE FUNCTION public.neu_guard_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF public.neu_role() NOT IN ('staff','admin') THEN RAISE EXCEPTION 'Staff or Admin required' USING ERRCODE='42501'; END IF;
 new.submitted_by=auth.uid();new.status='PENDING';new.review_note='';new.reviewed_by=NULL;new.reviewed_at=NULL;
 IF NOT EXISTS(SELECT 1 FROM public.opportunities WHERE id=new.opportunity_id AND verification='VERIFIED' AND NOT archived) THEN RAISE EXCEPTION 'Only published opportunities support proposed edits'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(new.proposed_patch) AS x(key) WHERE x.key NOT IN ('title','country','region','sector','stakeholder','description','eligibility','funding','deadline','application_status','source_org','source_url','application_url','contact_url','requirements','match_data')) THEN RAISE EXCEPTION 'Restricted proposed field'; END IF;
 RETURN new;
END $$;
CREATE OR REPLACE FUNCTION public.goid_validate_record(p jsonb) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE k text; m jsonb:=p->'match_data';
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid record'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) x(key) WHERE x.key NOT IN ('title','country','region','sector','stakeholder','description','eligibility','funding','deadline','application_status','source_org','source_url','application_url','contact_url','requirements','match_data','evidence')) THEN RAISE EXCEPTION 'Restricted record field'; END IF;
 FOREACH k IN ARRAY ARRAY['title','country','sector','description','eligibility','requirements','source_org','source_url','application_status'] LOOP
 IF nullif(btrim(p->>k),'') IS NULL THEN RAISE EXCEPTION 'Required field: %',k; END IF; END LOOP;
 IF p->>'source_url' !~* '^https://[^/[:space:]]+' THEN RAISE EXCEPTION 'HTTPS official source required'; END IF;
 IF p->>'country'='Philippines' AND nullif(btrim(p->>'region'),'') IS NULL THEN RAISE EXCEPTION 'Philippine region required'; END IF;
 IF jsonb_typeof(m) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Matching data required'; END IF;
 FOREACH k IN ARRAY ARRAY['intended_users','types','expenses','benefits','formats','documents','methods'] LOOP
 IF jsonb_typeof(m->k) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Matching field required: %',k; END IF;
 IF jsonb_array_length(m->k)=0 THEN RAISE EXCEPTION 'Matching field required: %',k; END IF; END LOOP;
 IF coalesce(m->>'funding_coverage','') NOT IN ('Fully Funded','Partially Funded','Self-Funded','Not Disclosed','Not Applicable') THEN RAISE EXCEPTION 'Select funding coverage'; END IF;
 IF coalesce(m->>'deadline_kind','') NOT IN ('Fixed Deadline','No Fixed Deadline','Not Yet Announced') THEN RAISE EXCEPTION 'Select deadline type'; END IF;
 IF m->>'deadline_kind'='Fixed Deadline' AND nullif(p->>'deadline','') IS NULL THEN RAISE EXCEPTION 'Fixed deadline requires a date'; END IF;
END $$;
-- Apply only allowlisted record fields; never apply role, score, reviewer or audit fields from a client patch.
CREATE OR REPLACE FUNCTION public.goid_apply_record(p_id uuid,p jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.opportunities SET title=p->>'title',country=p->>'country',region=coalesce(p->>'region',''),sector=p->>'sector',stakeholder=coalesce(p->>'stakeholder',''),description=coalesce(p->>'description',''),eligibility=coalesce(p->>'eligibility',''),funding=coalesce(p->>'funding',''),deadline=nullif(p->>'deadline','')::date,application_status=p->>'application_status',source_org=p->>'source_org',source_url=p->>'source_url',application_url=coalesce(p->>'application_url',''),contact_url=coalesce(p->>'contact_url',''),requirements=coalesce(p->>'requirements',''),match_data=p->'match_data' WHERE id=p_id;
END $$;
CREATE OR REPLACE FUNCTION public.goid_submit_opportunity(p_id uuid,p_revision uuid,p_record jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.opportunities%ROWTYPE; r public.opportunity_revisions%ROWTYPE; new_id uuid;
BEGIN
 IF public.neu_role() NOT IN ('staff','admin') THEN RAISE EXCEPTION 'Staff or Admin required' USING ERRCODE='42501'; END IF;
 PERFORM public.goid_validate_record(p_record);
 IF p_id IS NULL THEN
  INSERT INTO public.opportunities(title,country,region,sector,stakeholder,description,eligibility,funding,deadline,application_status,source_org,source_url,application_url,contact_url,requirements,match_data,evidence,created_by)
  VALUES(p_record->>'title',p_record->>'country',coalesce(p_record->>'region',''),p_record->>'sector',coalesce(p_record->>'stakeholder',''),p_record->>'description',p_record->>'eligibility',coalesce(p_record->>'funding',''),nullif(p_record->>'deadline','')::date,p_record->>'application_status',p_record->>'source_org',p_record->>'source_url',coalesce(p_record->>'application_url',''),coalesce(p_record->>'contact_url',''),p_record->>'requirements',p_record->'match_data',coalesce(p_record->'evidence','{}'::jsonb),auth.uid()) RETURNING id INTO new_id; RETURN new_id;
 END IF;
 SELECT * INTO o FROM public.opportunities WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR o.archived THEN RAISE EXCEPTION 'Record unavailable'; END IF;
 IF o.verification='VERIFIED' THEN
  IF p_revision IS NOT NULL THEN
   SELECT * INTO r FROM public.opportunity_revisions WHERE id=p_revision FOR UPDATE;
   IF NOT FOUND OR r.opportunity_id<>p_id OR r.submitted_by<>auth.uid() OR r.status<>'RETURNED' THEN RAISE EXCEPTION 'Returned revision not available'; END IF;
   UPDATE public.opportunity_revisions SET proposed_patch=p_record,status='PENDING',review_note='',reviewed_by=NULL,reviewed_at=NULL,review_checks='[]'::jsonb WHERE id=p_revision; RETURN p_revision;
  END IF;
  IF EXISTS(SELECT 1 FROM public.opportunity_revisions WHERE opportunity_id=p_id AND submitted_by=auth.uid() AND status='PENDING') THEN RAISE EXCEPTION 'A proposed edit is already pending'; END IF;
  INSERT INTO public.opportunity_revisions(opportunity_id,proposed_patch,submitted_by) VALUES(p_id,p_record,auth.uid()) RETURNING id INTO new_id; RETURN new_id;
 END IF;
 IF o.verification NOT IN ('PENDING VERIFICATION','RETURNED') OR (public.neu_role()<>'admin' AND o.created_by IS DISTINCT FROM auth.uid()) THEN RAISE EXCEPTION 'This record cannot be edited' USING ERRCODE='42501'; END IF;
 PERFORM public.goid_apply_record(p_id,p_record);
 UPDATE public.opportunities SET verification='PENDING VERIFICATION',review_note='',reviewed_by=NULL,reviewed_at=NULL,review_checks='[]'::jsonb WHERE id=p_id AND verification='RETURNED';
 RETURN p_id;
END $$;
CREATE OR REPLACE FUNCTION public.goid_verify_decision(p_decision text,p_checks integer[],p_note text) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF public.neu_role()<>'admin' THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF p_decision IS NULL OR p_decision NOT IN ('approve','return','reject') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
 IF p_decision='approve' AND NOT coalesce(p_checks @> ARRAY[1,2,3,4,5,6] AND cardinality(p_checks)=6,false) THEN RAISE EXCEPTION 'All six verification checks are required'; END IF;
 IF p_decision<>'approve' AND nullif(btrim(p_note),'') IS NULL THEN RAISE EXCEPTION 'Review comments are required'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.goid_review_opportunity(p_id uuid,p_decision text,p_checks integer[],p_note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.opportunities%ROWTYPE; nm text;
BEGIN
 PERFORM public.goid_verify_decision(p_decision,p_checks,p_note);
 SELECT * INTO o FROM public.opportunities WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR o.archived OR o.verification<>'PENDING VERIFICATION' THEN RAISE EXCEPTION 'Record is not pending review'; END IF;
 SELECT display_name INTO nm FROM public.profiles WHERE id=auth.uid();
 IF p_decision='approve' THEN
  PERFORM public.goid_validate_record(to_jsonb(o)-ARRAY['id','risks','benefit','feasibility','relevance','risk','difficulty','decision','action','verification','reviewer','last_verified','archived','is_demo','created_by','created_at','updated_at','reviewed_by','reviewed_at','review_note','review_checks']);
 END IF;
 UPDATE public.opportunities SET verification=CASE p_decision WHEN 'approve' THEN 'VERIFIED' WHEN 'return' THEN 'RETURNED' ELSE 'REJECTED' END,reviewer=nm,last_verified=CASE WHEN p_decision='approve' THEN (now() AT TIME ZONE 'Asia/Manila')::date ELSE last_verified END,reviewed_by=auth.uid(),reviewed_at=now(),review_note=left(coalesce(p_note,''),1000),review_checks=coalesce(to_jsonb(p_checks),'[]'::jsonb) WHERE id=p_id;
END $$;
CREATE OR REPLACE FUNCTION public.goid_review_edit(p_id uuid,p_decision text,p_checks integer[],p_note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.opportunity_revisions%ROWTYPE; o public.opportunities%ROWTYPE; merged jsonb; nm text;
BEGIN
 PERFORM public.goid_verify_decision(p_decision,p_checks,p_note);
 SELECT * INTO r FROM public.opportunity_revisions WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR r.status<>'PENDING' THEN RAISE EXCEPTION 'Revision is not pending'; END IF;
 SELECT * INTO o FROM public.opportunities WHERE id=r.opportunity_id FOR UPDATE;
 IF NOT FOUND OR o.archived OR o.verification<>'VERIFIED' THEN RAISE EXCEPTION 'Published record unavailable'; END IF;
 IF p_decision='approve' THEN
   merged:=(to_jsonb(o)-ARRAY['id','risks','benefit','feasibility','relevance','risk','difficulty','decision','action','verification','reviewer','last_verified','archived','is_demo','created_by','created_at','updated_at','reviewed_by','reviewed_at','review_note','review_checks'])||(r.proposed_patch-ARRAY['risks']);
   PERFORM public.goid_validate_record(merged); PERFORM public.goid_apply_record(o.id,merged);
   SELECT display_name INTO nm FROM public.profiles WHERE id=auth.uid();
   UPDATE public.opportunities SET reviewer=nm,last_verified=(now() AT TIME ZONE 'Asia/Manila')::date,reviewed_by=auth.uid(),reviewed_at=now(),review_note=left(coalesce(p_note,''),1000),review_checks=to_jsonb(p_checks) WHERE id=o.id;
 END IF;
 UPDATE public.opportunity_revisions SET status=CASE p_decision WHEN 'approve' THEN 'APPROVED' WHEN 'return' THEN 'RETURNED' ELSE 'REJECTED' END,review_note=left(coalesce(p_note,''),1000),reviewed_by=auth.uid(),reviewed_at=now(),review_checks=coalesce(to_jsonb(p_checks),'[]'::jsonb) WHERE id=p_id;
 INSERT INTO public.activity_log(actor_id,entity,entity_id,action,details) VALUES(auth.uid(),'opportunity_revision',o.id,upper(p_decision)||' EDIT',left(o.title||' · '||coalesce(p_note,''),1000));
END $$;
CREATE OR REPLACE FUNCTION public.goid_archive_opportunity(p_id uuid,p_action text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.opportunities%ROWTYPE;
BEGIN
 IF public.neu_role()<>'admin' THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM public.opportunities WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Record not found'; END IF;
 IF p_action='archive' THEN UPDATE public.opportunities SET archived=true,verification='ARCHIVED' WHERE id=p_id;
 ELSIF p_action='restore' THEN IF NOT(o.archived OR o.verification='ARCHIVED') THEN RAISE EXCEPTION 'Only archived records can be restored'; END IF;
 UPDATE public.opportunities SET archived=false,verification='PENDING VERIFICATION',reviewer='',last_verified=NULL,reviewed_by=NULL,reviewed_at=NULL,review_note='',review_checks='[]'::jsonb WHERE id=p_id;
 ELSIF p_action='delete' THEN
  IF NOT(o.archived OR o.verification='ARCHIVED') THEN RAISE EXCEPTION 'Archive the record first'; END IF;
  IF EXISTS(SELECT 1 FROM public.bookmarks WHERE opportunity_id=p_id) OR EXISTS(SELECT 1 FROM public.assistance_requests WHERE opportunity_id=p_id) OR EXISTS(SELECT 1 FROM public.opportunity_reports WHERE opportunity_id=p_id) OR EXISTS(SELECT 1 FROM public.opportunity_revisions WHERE opportunity_id=p_id) THEN RAISE EXCEPTION 'Related records exist. Keep this opportunity archived to protect history.'; END IF;
  DELETE FROM public.opportunities WHERE id=p_id;
 ELSE RAISE EXCEPTION 'Invalid archive action'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.goid_request_archive(p_id uuid,p_note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF public.neu_role() NOT IN ('staff','admin') THEN RAISE EXCEPTION 'Staff required'; END IF;
 IF nullif(btrim(p_note),'') IS NULL THEN RAISE EXCEPTION 'Reason required'; END IF;
 INSERT INTO public.opportunity_reports(opportunity_id,user_id,issue_type,description) VALUES(p_id,auth.uid(),'Other',left('Archive request: '||p_note,1000));
END $$;
-- Assistance assignment limits photo access. Existing conversations remain intact.
REVOKE UPDATE ON public.assistance_requests FROM authenticated;
CREATE OR REPLACE FUNCTION public.goid_claim_request(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF public.neu_role() NOT IN ('staff','admin') THEN RAISE EXCEPTION 'Staff required' USING ERRCODE='42501'; END IF;
 UPDATE public.assistance_requests SET assigned_to=auth.uid() WHERE id=p_id AND assigned_to IS NULL AND status<>'RESOLVED';
 IF NOT FOUND THEN RAISE EXCEPTION 'Request is no longer available to claim'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.goid_respond(p_id uuid,p_reply text,p_status text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF public.neu_role() NOT IN ('staff','admin') THEN RAISE EXCEPTION 'Staff required' USING ERRCODE='42501'; END IF;
 IF p_status NOT IN ('NEW','IN PROGRESS','RESOLVED') OR nullif(btrim(p_reply),'') IS NULL OR length(p_reply)>2000 THEN RAISE EXCEPTION 'Invalid reply or status'; END IF;
 UPDATE public.assistance_requests SET staff_reply=p_reply,status=p_status,assigned_to=coalesce(assigned_to,auth.uid()) WHERE id=p_id AND (assigned_to=auth.uid() OR public.neu_role()='admin');
 IF NOT FOUND THEN RAISE EXCEPTION 'Claim the request before responding'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.goid_review_feedback(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN IF public.neu_role() NOT IN ('staff','admin') THEN RAISE EXCEPTION 'Staff required' USING ERRCODE='42501'; END IF; UPDATE public.site_feedback SET status='REVIEWED' WHERE id=p_id; END $$;
CREATE OR REPLACE FUNCTION public.goid_staff_directory() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE j jsonb;
BEGIN IF public.neu_role() NOT IN ('staff','admin') THEN RAISE EXCEPTION 'Staff required' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_object_agg(id::text,display_name),'{}'::jsonb) INTO j FROM public.profiles p WHERE public.neu_role()='admin' OR p.role IN ('staff','admin') OR EXISTS(SELECT 1 FROM public.opportunities o WHERE o.created_by=p.id); RETURN j;
END $$;
CREATE OR REPLACE FUNCTION public.goid_request_profiles() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE j jsonb;
BEGIN IF public.neu_role() NOT IN ('staff','admin') THEN RAISE EXCEPTION 'Staff required' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_object_agg(p.id::text,jsonb_build_object('id',p.id,'display_name',p.display_name,'avatar_key',p.avatar_key,'photo_path',p.photo_path)),'{}'::jsonb) INTO j FROM public.profiles p WHERE EXISTS(SELECT 1 FROM public.assistance_requests r WHERE r.requester_id=p.id AND (r.assigned_to=auth.uid() OR public.neu_role()='admin')); RETURN j;
END $$;
CREATE OR REPLACE FUNCTION public.goid_analytics() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN IF public.neu_role() NOT IN ('staff','admin') THEN RAISE EXCEPTION 'Staff required' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('counts',jsonb_build_object('registered_accounts',(SELECT count(*) FROM public.profiles),'preferences_completed',(SELECT count(*) FROM public.goid_user_preferences),'bookmarks',(SELECT count(*) FROM public.bookmarks),'assistance_requests',(SELECT count(*) FROM public.assistance_requests)),'campuses',(SELECT coalesce(jsonb_object_agg(k,n),'{}'::jsonb) FROM (SELECT coalesce(nullif(campus,''),'Not provided') k,count(*) n FROM public.profiles GROUP BY 1)s),'colleges',(SELECT coalesce(jsonb_object_agg(k,n),'{}'::jsonb) FROM (SELECT coalesce(nullif(college,''),'Not provided') k,count(*) n FROM public.profiles GROUP BY 1)s));
END $$;
-- Persistent, recipient-scoped notifications. No caller can forge notifications.
CREATE OR REPLACE FUNCTION public.goid_emit(p_recipient uuid,p_kind text,p_title text,p_message text,p_target text,p_key text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_recipient IS NULL THEN RETURN; END IF;
 INSERT INTO public.goid_notifications(recipient_id,kind,title,message,target,dedupe_key)
 SELECT p_recipient,p_kind,p_title,p_message,p_target,p_key FROM public.profiles WHERE id=p_recipient AND active ON CONFLICT(recipient_id,dedupe_key) DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION public.goid_emit_roles(p_roles text[],p_kind text,p_title text,p_message text,p_target text,p_key text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO public.goid_notifications(recipient_id,kind,title,message,target,dedupe_key) SELECT id,p_kind,p_title,p_message,p_target,p_key FROM public.profiles WHERE active AND role=ANY(p_roles) AND id IS DISTINCT FROM auth.uid() ON CONFLICT(recipient_id,dedupe_key) DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION public.goid_mark_notifications(p_ids uuid[] DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN IF public.neu_role()='' THEN RAISE EXCEPTION 'Active account required' USING ERRCODE='42501'; END IF;
 UPDATE public.goid_notifications SET read_at=now() WHERE recipient_id=auth.uid() AND read_at IS NULL AND (p_ids IS NULL OR id=ANY(p_ids)); END $$;
CREATE OR REPLACE FUNCTION public.goid_notify_opportunity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF tg_op='INSERT' THEN
  IF new.verification='PENDING VERIFICATION' THEN PERFORM public.goid_emit_roles(ARRAY['admin'],'submission','New opportunity submission',new.title,'review/'||new.id::text); END IF;
  RETURN new;
 END IF;
 IF new.verification IS DISTINCT FROM old.verification THEN
  IF new.verification='PENDING VERIFICATION' THEN PERFORM public.goid_emit_roles(ARRAY['admin'],'submission','Opportunity awaiting verification',new.title,'review/'||new.id::text);
  ELSIF new.verification='VERIFIED' THEN
   INSERT INTO public.goid_notifications(recipient_id,kind,title,message,target,dedupe_key) SELECT id,'published','New opportunity published',new.title,'detail/'||new.id::text,'published:'||new.id::text FROM public.profiles WHERE active AND id IS DISTINCT FROM auth.uid() AND id IS DISTINCT FROM new.created_by ON CONFLICT(recipient_id,dedupe_key) DO NOTHING;
   IF new.created_by IS DISTINCT FROM auth.uid() THEN PERFORM public.goid_emit(new.created_by,'approved','Opportunity approved',new.title,'detail/'||new.id::text); END IF;
  ELSIF new.verification IN ('RETURNED','REJECTED') THEN PERFORM public.goid_emit(new.created_by,lower(new.verification),CASE new.verification WHEN 'RETURNED' THEN 'Revision requested' ELSE 'Submission rejected' END,new.title||' · '||new.review_note,'manage');
  END IF;
 END IF;
 RETURN new;
END $$;
CREATE OR REPLACE FUNCTION public.goid_notify_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE title text;
BEGIN SELECT o.title INTO title FROM public.opportunities o WHERE o.id=new.opportunity_id;
 IF tg_op='INSERT' THEN PERFORM public.goid_emit_roles(ARRAY['admin'],'proposed_edit','New proposed edit',coalesce(title,'Opportunity'),'revision/'||new.id::text);
 ELSIF new.status IS DISTINCT FROM old.status THEN
  IF new.status='PENDING' THEN PERFORM public.goid_emit_roles(ARRAY['admin'],'proposed_edit','Proposed edit resubmitted',coalesce(title,'Opportunity'),'revision/'||new.id::text);
  ELSE PERFORM public.goid_emit(new.submitted_by,'edit_decision','Proposed edit '||lower(new.status),coalesce(title,'Opportunity')||' · '||new.review_note,'manage'); END IF;
 END IF; RETURN new; END $$;
CREATE OR REPLACE FUNCTION public.goid_notify_assistance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF tg_op='INSERT' THEN PERFORM public.goid_emit_roles(ARRAY['staff','admin'],'assistance','New assistance request',new.help_type,'requests');
 ELSIF new.staff_reply IS DISTINCT FROM old.staff_reply OR new.status IS DISTINCT FROM old.status THEN PERFORM public.goid_emit(new.requester_id,'assistance_reply','Assistance request updated',new.help_type||' · '||new.status,'assistance'); END IF;
 RETURN new; END $$;
CREATE OR REPLACE FUNCTION public.goid_notify_support() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF tg_table_name='site_feedback' THEN PERFORM public.goid_emit_roles(ARRAY['staff','admin'],'feedback','New website feedback',new.topic,'requests');
 ELSE PERFORM public.goid_emit_roles(ARRAY['staff','admin'],'report','New information report',new.issue_type,'requests'); END IF;
 RETURN new; END $$;
CREATE OR REPLACE FUNCTION public.goid_notify_profile() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN IF new.role IS DISTINCT FROM old.role OR new.active IS DISTINCT FROM old.active THEN PERFORM public.goid_emit(new.id,'account','Account access updated','Your account permissions were changed.','profile'); END IF; RETURN new; END $$;
DROP TRIGGER IF EXISTS goid_notify_opportunity_trigger ON public.opportunities;
CREATE TRIGGER goid_notify_opportunity_trigger AFTER INSERT OR UPDATE ON public.opportunities FOR EACH ROW EXECUTE FUNCTION public.goid_notify_opportunity();
DROP TRIGGER IF EXISTS goid_notify_revision_trigger ON public.opportunity_revisions;
CREATE TRIGGER goid_notify_revision_trigger AFTER INSERT OR UPDATE ON public.opportunity_revisions FOR EACH ROW EXECUTE FUNCTION public.goid_notify_revision();
DROP TRIGGER IF EXISTS goid_notify_assistance_trigger ON public.assistance_requests;
CREATE TRIGGER goid_notify_assistance_trigger AFTER INSERT OR UPDATE ON public.assistance_requests FOR EACH ROW EXECUTE FUNCTION public.goid_notify_assistance();
DROP TRIGGER IF EXISTS goid_notify_report_trigger ON public.opportunity_reports;
CREATE TRIGGER goid_notify_report_trigger AFTER INSERT ON public.opportunity_reports FOR EACH ROW EXECUTE FUNCTION public.goid_notify_support();
DROP TRIGGER IF EXISTS goid_notify_feedback_trigger ON public.site_feedback;
CREATE TRIGGER goid_notify_feedback_trigger AFTER INSERT ON public.site_feedback FOR EACH ROW EXECUTE FUNCTION public.goid_notify_support();
DROP TRIGGER IF EXISTS goid_notify_profile_trigger ON public.profiles;
CREATE TRIGGER goid_notify_profile_trigger AFTER UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.goid_notify_profile();
CREATE OR REPLACE FUNCTION public.goid_deadline_reminders() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d date:=(now() AT TIME ZONE 'Asia/Manila')::date;
BEGIN IF public.neu_role()='' THEN RAISE EXCEPTION 'Active account required' USING ERRCODE='42501'; END IF;
 INSERT INTO public.goid_notifications(recipient_id,kind,title,message,target,dedupe_key)
 SELECT auth.uid(),'deadline','Saved opportunity deadline approaching',o.title||' · '||o.deadline::text,'detail/'||o.id::text,'deadline:'||o.id::text||':'||o.deadline::text FROM public.bookmarks b JOIN public.opportunities o ON o.id=b.opportunity_id WHERE b.user_id=auth.uid() AND o.verification='VERIFIED' AND NOT o.archived AND o.deadline BETWEEN d AND d+3 AND o.application_status NOT IN ('CLOSED','EXPIRED') ON CONFLICT(recipient_id,dedupe_key) DO NOTHING;
END $$;
-- Existing policies permit a few actions from disabled profiles; strengthen them without deleting records.
DROP POLICY IF EXISTS neu_bookmarks_add ON public.bookmarks;
CREATE POLICY neu_bookmarks_add ON public.bookmarks FOR INSERT TO authenticated WITH CHECK(user_id=auth.uid() AND public.neu_role()<>'' AND EXISTS(SELECT 1 FROM public.opportunities o WHERE o.id=opportunity_id AND o.verification='VERIFIED' AND NOT o.archived));
DROP POLICY IF EXISTS neu_bookmarks_select ON public.bookmarks;
CREATE POLICY neu_bookmarks_select ON public.bookmarks FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.neu_role()<>'');
DROP POLICY IF EXISTS neu_bookmarks_remove ON public.bookmarks;
CREATE POLICY neu_bookmarks_remove ON public.bookmarks FOR DELETE TO authenticated USING(user_id=auth.uid() AND public.neu_role()<>'');
DROP POLICY IF EXISTS goid_my_preferences_insert ON public.goid_user_preferences;
CREATE POLICY goid_my_preferences_insert ON public.goid_user_preferences FOR INSERT TO authenticated WITH CHECK(user_id=auth.uid() AND public.neu_role()<>'');
DROP POLICY IF EXISTS goid_my_preferences_read ON public.goid_user_preferences;
CREATE POLICY goid_my_preferences_read ON public.goid_user_preferences FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.neu_role()<>'');
DROP POLICY IF EXISTS goid_my_preferences_update ON public.goid_user_preferences;
CREATE POLICY goid_my_preferences_update ON public.goid_user_preferences FOR UPDATE TO authenticated USING(user_id=auth.uid() AND public.neu_role()<>'') WITH CHECK(user_id=auth.uid() AND public.neu_role()<>'');
DROP POLICY IF EXISTS neu_reports_insert ON public.opportunity_reports;
CREATE POLICY neu_reports_insert ON public.opportunity_reports FOR INSERT TO authenticated WITH CHECK(user_id=auth.uid() AND public.neu_role()<>'' AND status='OPEN' AND EXISTS(SELECT 1 FROM public.opportunities o WHERE o.id=opportunity_id AND o.verification='VERIFIED' AND NOT o.archived));
DROP POLICY IF EXISTS neu_feedback_insert ON public.site_feedback;
CREATE POLICY neu_feedback_insert ON public.site_feedback FOR INSERT TO authenticated WITH CHECK(user_id=auth.uid() AND public.neu_role()<>'' AND status='NEW');
DROP POLICY IF EXISTS neu_assistance_add ON public.assistance_requests;
CREATE POLICY neu_assistance_add ON public.assistance_requests FOR INSERT TO authenticated WITH CHECK(requester_id=auth.uid() AND public.neu_role()<>'' AND status='NEW' AND assigned_to IS NULL AND EXISTS(SELECT 1 FROM public.opportunities o WHERE o.id=opportunity_id AND o.verification='VERIFIED' AND NOT o.archived));
-- Public RPC surface: remove implicit PUBLIC execute, allow only explicitly authorized functions.
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('goid_valid_college','goid_can_read_photo','goid_update_profile','goid_update_photo','goid_profile_guard','goid_log_actor','goid_validate_record','goid_apply_record','goid_submit_opportunity','goid_verify_decision','goid_review_opportunity','goid_review_edit','goid_archive_opportunity','goid_request_archive','goid_claim_request','goid_respond','goid_review_feedback','goid_staff_directory','goid_request_profiles','goid_analytics','goid_emit','goid_emit_roles','goid_mark_notifications','goid_notify_opportunity','goid_notify_revision','goid_notify_assistance','goid_notify_support','goid_notify_profile','goid_deadline_reminders') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',f.sig);
 END LOOP; END $$;
CREATE OR REPLACE FUNCTION public.goid_update_scoring_settings(p_weights jsonb,p_high integer,p_medium integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE total numeric;
BEGIN
 IF public.neu_role()<>'admin' THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_weights) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_weights))<>5 THEN RAISE EXCEPTION 'Exactly five assessment weights are required'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_weights) e WHERE e.key NOT IN ('benefit','feasibility','relevance','risk','difficulty') OR e.value::text !~ '^[0-9]' OR e.value::text ~ '[^0-9]' OR (e.value::text)::integer NOT BETWEEN 0 AND 100) THEN RAISE EXCEPTION 'Weights must be whole numbers from 0 to 100'; END IF;
 SELECT sum((value::text)::integer) INTO total FROM jsonb_each(p_weights);
 IF total<>100 THEN RAISE EXCEPTION 'Assessment weights must total 100 percent'; END IF;
 IF p_high NOT BETWEEN 1 AND 100 OR p_medium NOT BETWEEN 0 AND p_high THEN RAISE EXCEPTION 'Invalid priority thresholds'; END IF;
 UPDATE public.app_settings SET weights=p_weights,high_threshold=p_high,medium_threshold=p_medium WHERE id=1;
 IF NOT FOUND THEN RAISE EXCEPTION 'GOID scoring settings row (id=1) is missing'; END IF;
 INSERT INTO public.activity_log(actor_id,entity,entity_id,action,details) VALUES(auth.uid(),'settings',NULL,'UPDATED SCORING SETTINGS',left('Weights: '||p_weights::text||'; High: '||p_high||'; Medium: '||p_medium,1000));
END $$;
REVOKE ALL ON FUNCTION public.goid_update_scoring_settings(jsonb,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.goid_update_scoring_settings(jsonb,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.goid_can_read_photo(text),public.goid_update_profile(jsonb),public.goid_update_photo(text,text),public.goid_submit_opportunity(uuid,uuid,jsonb),public.goid_review_opportunity(uuid,text,integer[],text),public.goid_review_edit(uuid,text,integer[],text),public.goid_archive_opportunity(uuid,text),public.goid_request_archive(uuid,text),public.goid_claim_request(uuid),public.goid_respond(uuid,text,text),public.goid_review_feedback(uuid),public.goid_staff_directory(),public.goid_request_profiles(),public.goid_analytics(),public.goid_mark_notifications(uuid[]),public.goid_deadline_reminders() TO authenticated;
-- Keep old settings/table for rollback and historical documentation, not active UI.
DO $$ DECLARE t text; BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
 FOREACH t IN ARRAY ARRAY['goid_notifications','site_feedback','profiles'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=t) THEN EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I',t); END IF;
 END LOOP; END IF; END $$;
-- Table-level privileges: RLS does not protect TRUNCATE. Keep only what the UI needs.
REVOKE TRUNCATE,REFERENCES,TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated,anon;
REVOKE DELETE ON public.assistance_requests,public.opportunity_reports,public.site_feedback FROM authenticated,anon;
DROP POLICY IF EXISTS neu_assistance_read ON public.assistance_requests;
CREATE POLICY neu_assistance_read ON public.assistance_requests FOR SELECT TO authenticated USING(public.neu_role()<>'' AND (requester_id=auth.uid() OR public.neu_role() IN ('staff','admin')));
DROP POLICY IF EXISTS neu_reports_select ON public.opportunity_reports;
CREATE POLICY neu_reports_select ON public.opportunity_reports FOR SELECT TO authenticated USING(public.neu_role()<>'' AND (user_id=auth.uid() OR public.neu_role() IN ('staff','admin')));
DROP POLICY IF EXISTS neu_feedback_select ON public.site_feedback;
CREATE POLICY neu_feedback_select ON public.site_feedback FOR SELECT TO authenticated USING(public.neu_role()<>'' AND (user_id=auth.uid() OR public.neu_role() IN ('staff','admin')));
CREATE OR REPLACE FUNCTION public.neu_requester_contact(p_request_id uuid) RETURNS TABLE(display_name text,email text,college text,year_level text,contact_number text,telegram_username text,preferred_contact text) LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF public.neu_role() NOT IN ('staff','admin') THEN RAISE EXCEPTION 'Staff required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT p.display_name,p.email,p.college,p.year_level,p.contact_number,p.telegram_username,p.preferred_contact FROM public.assistance_requests a JOIN public.profiles p ON p.id=a.requester_id WHERE a.id=p_request_id AND (public.neu_role()='admin' OR a.assigned_to=auth.uid());
END $$;

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
 RAISE NOTICE 'All 12 protected tables passed row-count and original-content checks.';
END
$goid_guard_verify$;
SELECT schema_name, table_name, row_count AS protected_rows,
 'Original records unchanged' AS preservation_result
 FROM pg_temp.goid_v2_preservation_guard ORDER BY schema_name,table_name;

ROLLBACK;
