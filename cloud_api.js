/* NEU Global Opportunities — secure shared Supabase adapter.
   The public Supabase publishable key is safe in config.js. Never place secret keys here.
   Real permissions are enforced by Supabase Row Level Security and upgrade SQL. */
'use strict';
const NEU_ALLOWED_COUNTRIES=['Philippines','Japan','South Korea','Singapore','Malaysia','Thailand'];
const NEU_ALLOWED_SECTORS=['Academic Internationalization','Research Internationalization','Business/Industry Internationalization','Community/MSME Internationalization'];
const NEU_CRITERIA=['benefit','feasibility','relevance','risk','difficulty'];
const NEU_DEFAULT_SETTINGS={weights:{benefit:30,feasibility:25,relevance:20,risk:15,difficulty:10},high_threshold:80,medium_threshold:60};
const NEU_RUBRIC={
 benefit:[['FULL','Full funding or comprehensive documented support',5],['PARTIAL','Documented partial funding or material support',4],['NONFINANCIAL','Documented non-financial program benefits',3],['LIMITED','Limited documented benefits',2],['NONE','No documented participant benefit',1]],
 feasibility:[['ALL_CLEAR','Eligibility and process are fully published and accessible',5],['CLEAR','Clear requirements with normal restrictions',4],['CONDITIONAL','Special eligibility conditions documented',3],['RESTRICTED','Significant published eligibility restrictions',2],['INELIGIBLE','Requirements rule out the target group',1]],
 relevance:[['DIRECT','Direct match to an explicitly stated project objective',5],['STRONG','Strong match to an explicit objective',4],['RELATED','Related to an explicit objective',3],['INDIRECT','Indirect connection to stated objectives',2],['NONE','No documented alignment',1]],
 risk:[['LOW','Published safeguards and no identified major barriers',5],['MANAGEABLE','Some documented risks with clear safeguards',4],['MODERATE','Documented meaningful risks or uncertainty',3],['HIGH','Significant documented risks',2],['CRITICAL','Severe documented risks or restrictions',1]],
 difficulty:[['SIMPLE','Few documented steps and minimal prerequisites',5],['ROUTINE','Standard documented requirements',4],['MODERATE','Multiple requirements and some coordination',3],['COMPLEX','Extensive documents, partners or procedures',2],['VERY_COMPLEX','Very demanding or inaccessible process',1]]
};
const NEU_PUBLIC_SELECT='id,title,country,region,sector,stakeholder,description,eligibility,funding,deadline,application_status,source_org,source_url,application_url,contact_url,requirements,risks,verification,last_verified,archived,evidence,created_at';
const NEU_SAFE_FIELDS=['title','country','region','sector','stakeholder','description','eligibility','funding','deadline','application_status','source_org','source_url','application_url','contact_url','requirements','risks','evidence','decision'];
let neuClient=null, neuChannel=null, neuRefreshHandle=null, neuPollingHandle=null;
function neuConfigured(){const x=window.NEU_CONFIG||{};return /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(x.url||'') && /^(sb_publishable_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9._-]+)$/.test(x.publishableKey||'');}
function neuGetClient(){
 if(!neuConfigured())throw Error('Connect your existing Supabase Project URL and publishable key in config.js. Do not use a secret/service-role key.');
 if(!window.supabase||typeof window.supabase.createClient!=='function')throw Error('Supabase could not load. Check the internet connection.');
 if(!neuClient)neuClient=window.supabase.createClient(window.NEU_CONFIG.url,window.NEU_CONFIG.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
 return neuClient;
}
function neuFail(e){if(e)throw Error(e.message||String(e));}
function neuLink(url){return typeof url==='string' && /^https:\/\/[\w.-]+(?:[:/]|$)/i.test(url.trim());}
function neuClean(input,update=false){
 const d={};for(const k of NEU_SAFE_FIELDS)if(Object.prototype.hasOwnProperty.call(input,k))d[k]=input[k];
 if((!update||'title'in d)&&!String(d.title||'').trim())throw Error('Opportunity title is required.');
 if((!update||'country'in d)&&!NEU_ALLOWED_COUNTRIES.includes(d.country))throw Error('Choose a supported country.');
 if((!update||'sector'in d)&&!NEU_ALLOWED_SECTORS.includes(d.sector))throw Error('Choose a valid opportunity category.');
 for(const k of ['source_url','application_url','contact_url'])if(k in d && d[k] && !neuLink(d[k]))throw Error('Official links must use HTTPS.');
 if('evidence'in d){if(d.evidence===null||Array.isArray(d.evidence)||typeof d.evidence!=='object')throw Error('Evidence must be a set of rubric choices.');
  for(const k of Object.keys(d.evidence)){if(!NEU_CRITERIA.includes(k))throw Error('Unexpected evidence criterion: '+k);
   const e=d.evidence[k];if(!e||!NEU_RUBRIC[k].some(r=>r[0]===e.code)||!neuLink(e.source_url||''))throw Error('Each assessed criterion requires a valid rubric choice and HTTPS evidence link.');}}
 if('country'in d&&d.country!=='Philippines')d.region='';
 if('decision'in d&&!['PURSUE','MONITOR','INVESTIGATE FURTHER','REJECT'].includes(d.decision))throw Error('Choose a valid decision status.');
 if('deadline'in d)d.deadline=d.deadline||null;
 return d;
}
function neuScore(o,settings=NEU_DEFAULT_SETTINGS){
 const evidence=o.evidence && typeof o.evidence==='object'?o.evidence:{};
 const lines=NEU_CRITERIA.map(k=>{
  const item=evidence[k]||{},found=NEU_RUBRIC[k].find(v=>v[0]===item.code);
  return {key:k,label:k==='benefit'?'Potential benefit':k==='risk'?'Manageable risk':k==='difficulty'?'Ease of implementation':k==='relevance'?'Strategic relevance':'Feasibility',code:item.code||'',source_url:item.source_url||'',description:found?.[1]||'Not documented',rating:found?.[2]||null,weight:Number(settings.weights[k]||0)};
 });
 const missing=lines.filter(x=>!x.rating||!neuLink(x.source_url));
 const assessed=missing.length===0;
 const score=assessed?Math.round(lines.reduce((sum,l)=>sum+l.rating*l.weight/5,0)*10)/10:null;
 const priority=score===null?'NOT ASSESSED':score>=settings.high_threshold?'HIGH':score>=settings.medium_threshold?'MEDIUM':'LOW';
 return {...o,evidence,score,priority,assessment:{assessed,missing:missing.map(x=>x.key),lines},is_demo:false};
}
async function neuUser(){const {data,error}=await neuGetClient().auth.getUser();if(error)return null;return data?.user||null;}
async function neuRole(required){const user=await neuUser();if(!user)throw Error('Sign in with your authorized account.');
 const {data,error}=await neuGetClient().from('profiles').select('role,active').eq('id',user.id).single();neuFail(error);
 if(!data?.active||({student:0,staff:1,admin:2}[data.role]??-1)<({student:0,staff:1,admin:2}[required]??0))throw Error('Your account does not have permission for this action.');return {user,role:data.role};}
async function neuRead(table,options={}){let q=neuGetClient().from(table).select(options.columns||'*');
 if(options.order)q=q.order(options.order,{ascending:!!options.ascending});if(options.limit)q=q.limit(options.limit);
 const {data,error}=await q;neuFail(error);return data||[];}
async function neuApi(path,method='GET',body={}){
 const c=neuGetClient();
 if(path==='/api/login'&&method==='POST'){const {error}=await c.auth.signInWithPassword({email:String(body.email||'').trim(),password:String(body.password||'')});neuFail(error);return {ok:true};}
 if(path==='/api/logout'&&method==='POST'){const {error}=await c.auth.signOut();neuFail(error);return {ok:true};}
 if(path==='/api/signup'&&method==='POST'){
  const clean=k=>String(body[k]||'').trim();
  const name=clean('full_name'),college=clean('college'),year=clean('year_level'),email=clean('email').toLowerCase(),pass=String(body.password||'');
  if(name.length<2||name.length>120||college.length<2||college.length>120||!['1st Year','2nd Year','3rd Year','4th Year','5th Year','Graduate / Postgraduate','Other'].includes(year))throw Error('Complete your name, college/department, and year level.');
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)||pass.length<10)throw Error('Enter a valid email and a password with at least 10 characters.');
  if(body.privacy_acknowledged!==true)throw Error('Read and acknowledge the privacy notice before registering.');
  const phone=clean('contact_number'),telegram=clean('telegram_username');
  if(phone.length>30||telegram.length>50||(telegram&&!/^@?[A-Za-z0-9_]{5,32}$/.test(telegram)))throw Error('Check the optional contact details.');
  const {data,error}=await c.auth.signUp({email,password:pass,options:{emailRedirectTo:window.location.origin+window.location.pathname,data:{full_name:name,college,year_level:year,contact_number:phone,telegram_username:telegram,privacy_acknowledged:true}}});neuFail(error);
  // Supabase may avoid revealing whether an email address is already registered.
  if(data?.session){await c.auth.signOut();throw Error('Email confirmation appears disabled. Enable Confirm Email in Supabase before opening registration.');}
  return {ok:true,email};
 }
 if(path==='/api/resend-confirmation'&&method==='POST'){
  const email=String(body.email||'').trim();if(!email)throw Error('Enter your email.');
  const {error}=await c.auth.resend({type:'signup',email,options:{emailRedirectTo:window.location.origin+window.location.pathname}});neuFail(error);return {ok:true};
 }
 if(path==='/api/forgot-password'&&method==='POST'){
  const email=String(body.email||'').trim();if(!email)throw Error('Enter your email.');
  const {error}=await c.auth.resetPasswordForEmail(email,{redirectTo:window.location.origin+window.location.pathname});neuFail(error);return {ok:true};
 }
 if(path==='/api/new-password'&&method==='POST'){
  const password=String(body.password||'');if(password.length<10)throw Error('Use at least 10 characters.');
  const {error}=await c.auth.updateUser({password});neuFail(error);await c.auth.signOut();return {ok:true};
 }
 if(path==='/api/my-profile'&&method==='PATCH'){
  const {user}=await neuRole('student');
  const display_name=String(body.display_name||'').trim(),college=String(body.college||'').trim(),year_level=String(body.year_level||'').trim();
  const contact_number=String(body.contact_number||'').trim(),telegram_username=String(body.telegram_username||'').trim();
  const preferred_contact=String(body.preferred_contact||'Email');
  if(display_name.length<2||display_name.length>120||college.length<2||college.length>120||!['1st Year','2nd Year','3rd Year','4th Year','5th Year','Graduate / Postgraduate','Other'].includes(year_level))throw Error('Enter your name, college, and year level.');
  if(contact_number.length>30||telegram_username.length>50||(telegram_username&&!/^@?[A-Za-z0-9_]{5,32}$/.test(telegram_username)))throw Error('Check your contact details.');
  if(!['Email','Telegram','Phone'].includes(preferred_contact))throw Error('Choose a contact method.');
  if((preferred_contact==='Telegram'&&!telegram_username)||(preferred_contact==='Phone'&&!contact_number))throw Error('Add your preferred contact information first.');
  const {error}=await c.from('profiles').update({display_name,college,year_level,contact_number,telegram_username,preferred_contact}).eq('id',user.id);neuFail(error);return {ok:true};
 }

 if(path==='/api/bootstrap'){
  const user=await neuUser();let profile=null;
  if(!user)return {authenticated:false,me:null,opportunities:[],settings:NEU_DEFAULT_SETTINGS,users:[],bookmarks:[],requests:[],revisions:[],reports:[],feedback:[],activity:[]};
  if(user){const {data,error}=await c.from('profiles').select('id,email,display_name,role,active,college,year_level,contact_number,telegram_username,preferred_contact').eq('id',user.id).single();neuFail(error);if(!data.active)throw Error('Account disabled. Please contact an administrator.');profile=data;}
  const [settingsResp,oppsResp]=await Promise.all([
   c.from('app_settings').select('weights,high_threshold,medium_threshold').eq('id',1).single(),
   c.from('opportunities').select('*').order('created_at',{ascending:false}).limit(2000)
  ]);
  // Pages are accessible only after a verified account signs in.
  const settings=settingsResp.data||NEU_DEFAULT_SETTINGS;
  neuFail(oppsResp.error);
  let users=[],bookmarks=[],requests=[],revisions=[],reports=[],feedback=[],activity=[];
  if(user){
   const jobs=[neuRead('bookmarks'),neuRead('assistance_requests',{order:'created_at',limit:500}),neuRead('opportunity_reports',{order:'created_at',limit:500}),neuRead('site_feedback',{order:'created_at',limit:500})];
   if(profile.role==='staff'||profile.role==='admin')jobs.push(neuRead('opportunity_revisions',{order:'created_at',limit:500}));
   if(profile.role==='admin')jobs.push(neuRead('profiles',{order:'created_at'}),neuRead('activity_log',{order:'created_at',limit:100}));
   const result=await Promise.all(jobs);[bookmarks,requests,reports,feedback]=result;
   let offset=4;if(profile.role!=='student'){revisions=result[offset++];}if(profile.role==='admin'){users=result[offset++];activity=result[offset++];}
  }
  return {authenticated:true,me:profile,opportunities:(oppsResp.data||[]).map(o=>neuScore(o,settings)),settings,users,bookmarks,requests,revisions,reports,feedback,activity};
 }
 const record=path.match(/^\/api\/opportunities\/([0-9a-f-]{36})(?:\/(approve))?$/);
 if(path==='/api/opportunities'&&method==='POST'){
  const {user}=await neuRole('staff');const d=neuClean(body);if(!neuLink(d.source_url)||!String(d.source_org||'').trim())throw Error('Add the official source organization and HTTPS link.');
  delete d.decision;d.created_by=user.id;d.verification='PENDING VERIFICATION';d.archived=false;
  const {data,error}=await c.from('opportunities').insert(d).select('id').single();neuFail(error);return {ok:true,id:data.id};
 }
 if(record&&record[2]==='approve'&&method==='POST'){
  await neuRole('admin');const id=record[1];const {data:old,error:oldError}=await c.from('opportunities').select('*').eq('id',id).single();neuFail(oldError);
  if(!String(old.source_org||'').trim()||!neuLink(old.source_url)||!String(body.reviewer||'').trim()||(old.country==='Philippines'&&!old.region))throw Error('Approval requires the official source, source organization, reviewer name, and Philippine region when applicable.');
  const {error}=await c.from('opportunities').update({verification:'VERIFIED',reviewer:String(body.reviewer).trim(),last_verified:new Date().toISOString().slice(0,10)}).eq('id',id);neuFail(error);return {ok:true};
 }
 if(record&&!record[2]&&method==='PATCH'){
  const {role}=await neuRole('staff');const d=neuClean(body,true);if(!Object.keys(d).length&&!('archived'in body)&&!('verification'in body))throw Error('No changes to save.');
  const {data:old,error:e}=await c.from('opportunities').select('id,verification,created_by').eq('id',record[1]).single();neuFail(e);
  if(role==='staff'&&'decision' in d)throw Error('Decision status can be changed by Admin only.');
  if(role==='staff'&&old.verification==='VERIFIED'){
   if(!Object.keys(d).length)throw Error('No change to submit.');
   const {error}=await c.from('opportunity_revisions').insert({opportunity_id:record[1],proposed_patch:d});neuFail(error);
   return {ok:true,pending_revision:true};
  }
  if(role==='staff'&&('archived'in body||'verification'in body))throw Error('Only Admin can change publication status.');
  if(role==='admin'){if('archived'in body)d.archived=!!body.archived;if('verification'in body){if(!['VERIFIED','PENDING VERIFICATION','EXPIRED','ARCHIVED'].includes(body.verification))throw Error('Invalid verification status.');d.verification=body.verification;}}
  const {error}=await c.from('opportunities').update(d).eq('id',record[1]);neuFail(error);return {ok:true};
 }
 if(record&&!record[2]&&method==='DELETE'){
  await neuRole('admin');const {error}=await c.from('opportunities').delete().eq('id',record[1]);neuFail(error);return {ok:true};
 }
 const review=path.match(/^\/api\/revisions\/([0-9a-f-]{36})\/review$/);
 if(review&&method==='POST'){
  await neuRole('admin');const {error}=await c.rpc('neu_review_revision',{p_revision_id:review[1],p_approve:!!body.approve,p_reviewer_name:body.reviewer||'',p_note:body.note||''});neuFail(error);return {ok:true};
 }
 const bm=path.match(/^\/api\/bookmarks\/([0-9a-f-]{36})$/);
 if(bm&&method==='POST'){
  const {user}=await neuRole('student');const {error}=await c.from('bookmarks').upsert({user_id:user.id,opportunity_id:bm[1]},{onConflict:'user_id,opportunity_id'});neuFail(error);return {ok:true};
 }
 if(bm&&method==='DELETE'){
  const {user}=await neuRole('student');const {error}=await c.from('bookmarks').delete().eq('user_id',user.id).eq('opportunity_id',bm[1]);neuFail(error);return {ok:true};
 }
 if(path==='/api/assistance'&&method==='POST'){
  const {user}=await neuRole('student');const d={opportunity_id:body.opportunity_id,requester_id:user.id,requester_name:'Account holder',requester_email:user.email||'',help_type:body.help_type,message:String(body.message||'').trim()};
  if(d.message.length>2000)throw Error('Message too long.');
  const {error}=await c.from('assistance_requests').insert(d);neuFail(error);return {ok:true};
 }
 const contact=path.match(/^\/api\/assistance\/([0-9a-f-]{36})\/contact$/);
 if(contact&&method==='GET'){
  await neuRole('staff');const {data,error}=await c.rpc('neu_requester_contact',{p_request_id:contact[1]});neuFail(error);return Array.isArray(data)?data[0]||{}:data||{};
 }
 const assist=path.match(/^\/api\/assistance\/([0-9a-f-]{36})$/);
 if(assist&&method==='PATCH'){
  await neuRole('staff');if(!['NEW','IN PROGRESS','RESOLVED'].includes(body.status))throw Error('Choose a valid request status.');
  const {error}=await c.from('assistance_requests').update({status:body.status,staff_reply:String(body.staff_reply||'').slice(0,2000)}).eq('id',assist[1]);neuFail(error);return {ok:true};
 }
 if(path==='/api/reports'&&method==='POST'){
  const {user}=await neuRole('student');const {error}=await c.from('opportunity_reports').insert({opportunity_id:body.opportunity_id,user_id:user.id,issue_type:body.issue_type,description:String(body.description||'').trim()});neuFail(error);return {ok:true};
 }
 const report=path.match(/^\/api\/reports\/([0-9a-f-]{36})$/);
 if(report&&method==='PATCH'){
  await neuRole('staff');if(!['OPEN','REVIEWED'].includes(body.status))throw Error('Invalid report status.');const {error}=await c.from('opportunity_reports').update({status:body.status}).eq('id',report[1]);neuFail(error);return {ok:true};
 }
 if(path==='/api/feedback'&&method==='POST'){
  const {user}=await neuRole('student');const {error}=await c.from('site_feedback').insert({user_id:user.id,topic:body.topic,message:String(body.message||'').trim()});neuFail(error);return {ok:true};
 }
 if(path==='/api/settings'&&method==='PATCH'){
  await neuRole('admin');const w=body.weights;
  if(!w||NEU_CRITERIA.some(k=>!Number.isInteger(w[k])||w[k]<0||w[k]>100)||NEU_CRITERIA.reduce((sum,k)=>sum+w[k],0)!==100)throw Error('Five percentages must be whole numbers adding to 100%.');
  const h=Number(body.high_threshold),m=Number(body.medium_threshold);
  if(!Number.isInteger(h)||!Number.isInteger(m)||m<0||m>=h||h>100)throw Error('Invalid priority thresholds.');
  const {error}=await c.from('app_settings').update({weights:w,high_threshold:h,medium_threshold:m}).eq('id',1);neuFail(error);return {ok:true};
 }
 const matchUser=path.match(/^\/api\/users\/([0-9a-f-]{36})$/);
 if(matchUser&&method==='PATCH'){
  const {user}=await neuRole('admin');const d={};if('role'in body){if(!['admin','staff','student'].includes(body.role))throw Error('Invalid role.');d.role=body.role;}if('active'in body)d.active=!!body.active;
  if(user.id===matchUser[1]&&(d.role&&d.role!=='admin'||d.active===false))throw Error('Cannot remove your own Admin access.');
  const {error}=await c.rpc('neu_admin_update_user',{p_target:matchUser[1],p_new_role:d.role||null,p_active:('active'in d?d.active:null)});neuFail(error);return {ok:true};
 }
 if(path==='/api/import'&&method==='POST'){
  const {user}=await neuRole('staff');if(!Array.isArray(body.opportunities)||body.opportunities.length>100)throw Error('Import up to 100 records at a time.');let count=0,skipped=0;
  for(const item of body.opportunities){try{
   const d=neuClean(item);if(!neuLink(d.source_url)||!d.source_org)throw Error('Missing official source');
   delete d.decision;d.created_by=user.id;d.verification='PENDING VERIFICATION';d.archived=false;
   const {error}=await c.from('opportunities').insert(d);if(error)throw Error(error.message);count++;
  }catch{skipped++;}}
  return {ok:true,count,skipped};
 }
 throw Error('Unsupported operation: '+path);
}
function neuDownloadExport(type,records){
 const keys=['title','country','region','sector','stakeholder','description','eligibility','funding','deadline','application_status','source_org','source_url','application_url','contact_url','requirements','risks','verification','reviewer','last_verified','score','priority'];
 const rows=records||[];let content,mime,name;
 if(type==='csv'){
  const cell=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  content='\ufeff'+keys.join(',')+'\r\n'+rows.map(o=>keys.map(k=>cell(o[k])).join(',')).join('\r\n');mime='text/csv;charset=utf-8';name='neu-opportunities.csv';
 }else{
  content=JSON.stringify({exported_at:new Date().toISOString(),opportunities:rows.map(o=>Object.fromEntries([...keys,'evidence'].map(k=>[k,o[k]])))},null,2);
  mime='application/json';name='neu-opportunities.json';
 }
 const url=URL.createObjectURL(new Blob([content],{type:mime}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
}
function neuActivateRealtime(refresh){
 if(neuChannel)return;const c=neuGetClient();const load=()=>{clearTimeout(neuRefreshHandle);neuRefreshHandle=setTimeout(refresh,500);};
 neuChannel=c.channel('neu-live-data').on('postgres_changes',{event:'*',schema:'public',table:'opportunities'},load)
 .on('postgres_changes',{event:'*',schema:'public',table:'app_settings'},load)
 .on('postgres_changes',{event:'*',schema:'public',table:'assistance_requests'},load)
 .on('postgres_changes',{event:'*',schema:'public',table:'opportunity_revisions'},load).subscribe();
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
 if(!neuPollingHandle)neuPollingHandle=setInterval(()=>{if(!document.hidden)load();},45000);
}
