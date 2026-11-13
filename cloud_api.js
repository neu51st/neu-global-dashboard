/* NEU Global Opportunity Dashboard — Supabase adapter.
 * Uses Supabase Auth + row-level security; never ships a secret or service-role key.
 * All server-side permissions are enforced by schema.sql.
 */
'use strict';
const NEU_ALLOWED_COUNTRIES=['Philippines','Japan','South Korea','Singapore','Malaysia','Thailand'];
const NEU_ALLOWED_SECTORS=['Academic Internationalization','Research Internationalization','Business/Industry Internationalization','Community/MSME Internationalization'];
const NEU_RATINGS=['benefit','feasibility','relevance','risk','difficulty'];
const NEU_FIELDS=['title','country','region','sector','stakeholder','source_org','source_url','application_url','description','eligibility','funding','deadline','application_status','action','risks','requirements','benefit','feasibility','relevance','risk','difficulty','decision','reviewer','last_verified','verification','archived'];
const NEU_DEFAULT_SETTINGS={weights:{benefit:30,feasibility:25,relevance:20,risk:15,difficulty:10},high_threshold:80,medium_threshold:60};
let neuClient=null, neuChannel=null, neuRefreshHandle=null, neuPollingHandle=null;
function neuConfigured(){const x=window.NEU_CONFIG||{};return /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(x.url||'') && /^sb_publishable_[A-Za-z0-9_-]+$/.test(x.publishableKey||'');}
function neuGetClient(){
 if(!neuConfigured())throw Error('Website setup is not finished. Add your Supabase Project URL and PUBLISHABLE key to config.js, then reload. Never use a secret key.');
 if(!window.supabase||typeof window.supabase.createClient!=='function')throw Error('Cannot load the Supabase website library. Connect to the internet and reload.');
 if(!neuClient)neuClient=window.supabase.createClient(window.NEU_CONFIG.url,window.NEU_CONFIG.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
 return neuClient;
}
function neuError(e){if(e)throw Error(e.message||String(e));}
function neuClean(input,forUpdate=false){
 const d={};for(const k of NEU_FIELDS){if(Object.prototype.hasOwnProperty.call(input,k))d[k]=input[k];}
 if(!forUpdate||Object.prototype.hasOwnProperty.call(d,'title')){if(!String(d.title||'').trim())throw Error('Enter an opportunity title.');}
 if(!forUpdate||Object.prototype.hasOwnProperty.call(d,'country')){if(!NEU_ALLOWED_COUNTRIES.includes(d.country))throw Error('Please choose a supported location.');}
 if(!forUpdate||Object.prototype.hasOwnProperty.call(d,'sector')){if(!NEU_ALLOWED_SECTORS.includes(d.sector))throw Error('Please choose a valid category.');}
 for(const k of NEU_RATINGS)if(k in d){d[k]=Number(d[k]);if(!Number.isInteger(d[k])||d[k]<1||d[k]>5)throw Error('Ratings must be between 1 and 5.');}
 if('deadline' in d)d.deadline=d.deadline||null;
 if('last_verified' in d)d.last_verified=d.last_verified||null;
 if('country' in d && d.country!=='Philippines')d.region='';
 for(const k of ['source_url','application_url'])if(d[k]&&!/^https:\/\//i.test(d[k]))throw Error('Use HTTPS links from official sources.');
 return d;
}
function neuScore(o,settings){const s=settings||NEU_DEFAULT_SETTINGS;const value=NEU_RATINGS.reduce((sum,k)=>sum+(Number(o[k])||3)*(Number(s.weights[k])||0)/5,0);return {...o,is_demo:false,region:o.region||'',deadline:o.deadline||'',last_verified:o.last_verified||'',score:Math.round(value*10)/10,priority:value>=s.high_threshold?'HIGH':value>=s.medium_threshold?'MEDIUM':'LOW'};}
async function neuGetAuthenticated(){const c=neuGetClient();const {data,error}=await c.auth.getUser();if(error||!data?.user)return null;return data.user;}
async function neuRequireRole(min){const u=await neuGetAuthenticated();if(!u)throw Error('Please sign in again.');const {data,error}=await neuGetClient().from('profiles').select('role,active').eq('id',u.id).single();neuError(error);const rank={student:0,staff:1,admin:2};if(!data.active||(rank[data.role]??-1)<rank[min])throw Error('Your account cannot perform this action.');return u;}
async function neuApi(path,method='GET',body={}){
 const c=neuGetClient();
 if(path==='/api/login'&&method==='POST'){
  const email=String(body.username||'').trim();const password=String(body.password||'');
  const {error}=await c.auth.signInWithPassword({email,password});neuError(error);return {ok:true};
 }
 if(path==='/api/logout'&&method==='POST'){const {error}=await c.auth.signOut();neuError(error);return {ok:true};}
 if(path==='/api/bootstrap'){
  const user=await neuGetAuthenticated();if(!user)return {authenticated:false};
  const {data:profile,error:profileError}=await c.from('profiles').select('id,email,display_name,role,active').eq('id',user.id).single();
  if(profileError)throw Error('Profile unavailable. Check that SETUP_DATABASE.sql has been run. '+profileError.message);
  if(!profile.active)throw Error('This account is disabled. Contact your group administrator.');
  const [settingsReply,oppReply]=await Promise.all([
   c.from('app_settings').select('weights,high_threshold,medium_threshold').eq('id',1).single(),
   c.from('opportunities').select('*').order('created_at',{ascending:false}).limit(2000)
  ]);
  neuError(settingsReply.error);neuError(oppReply.error);
  const settings=settingsReply.data||NEU_DEFAULT_SETTINGS;
  let profiles=[];
  if(profile.role==='admin'){const p=await c.from('profiles').select('id,email,display_name,role,active').order('created_at');neuError(p.error);profiles=p.data||[];}
  return {authenticated:true,me:{id:profile.id,username:profile.email,role:profile.role,display_name:profile.display_name},opportunities:(oppReply.data||[]).map(o=>neuScore(o,settings)),settings,users:profiles};
 }
 const user=await neuGetAuthenticated();if(!user)throw Error('Please sign in to continue.');
 if(path==='/api/opportunities'&&method==='POST'){
  await neuRequireRole('staff');const d=neuClean(body);d.created_by=user.id;d.verification='PENDING VERIFICATION';d.archived=false;
  delete d.reviewer;delete d.last_verified;
  const {data,error}=await c.from('opportunities').insert(d).select('id').single();neuError(error);return {ok:true,id:data.id};
 }
 const match=path.match(/^\/api\/opportunities\/([\da-f-]{36})$/);
 if(match&&method==='PATCH'){
  await neuRequireRole('staff');const d=neuClean(body,true);
  if(Object.keys(d).length===0)throw Error('No changes to save.');
  const {error}=await c.from('opportunities').update(d).eq('id',match[1]);neuError(error);return {ok:true};
 }
 if(match&&method==='DELETE'){
  await neuRequireRole('admin');const {error}=await c.from('opportunities').delete().eq('id',match[1]);neuError(error);return {ok:true};
 }
 if(path==='/api/settings'&&method==='PATCH'){
  await neuRequireRole('admin');const w=body.weights;
  if(!w||NEU_RATINGS.some(k=>!Number.isInteger(w[k])||w[k]<0||w[k]>100)||NEU_RATINGS.reduce((sum,k)=>sum+w[k],0)!==100)throw Error('All five weights must be whole numbers totaling 100%.');
  const high=Number(body.high_threshold),medium=Number(body.medium_threshold);
  if(!(Number.isInteger(high)&&Number.isInteger(medium)&&medium>=0&&medium<high&&high<=100))throw Error('Priority thresholds are invalid.');
  const {error}=await c.from('app_settings').update({weights:w,high_threshold:high,medium_threshold:medium}).eq('id',1);neuError(error);return {ok:true};
 }
 if(path==='/api/import'&&method==='POST'){
  await neuRequireRole('staff');if(!Array.isArray(body.opportunities)||body.opportunities.length>150)throw Error('Import up to 150 records at a time.');
  const {data:existing,error:existingError}=await c.from('opportunities').select('title,source_url');neuError(existingError);
  const keys=new Set((existing||[]).map(o=>`${String(o.title).toLowerCase()}|${o.source_url}`));let count=0,skipped=0;
  for(const item of body.opportunities){try{
    if(!item.source_url||!/^https:\/\//.test(item.source_url))throw Error('No official HTTPS source');
    const key=`${String(item.title||'').toLowerCase()}|${item.source_url}`;if(keys.has(key)){skipped++;continue;}
    const d=neuClean({stakeholder:'Students',benefit:3,feasibility:3,relevance:3,risk:3,difficulty:3,decision:'INVESTIGATE FURTHER',...item});
    d.created_by=user.id;d.verification='PENDING VERIFICATION';d.archived=false;delete d.reviewer;delete d.last_verified;
    const {error}=await c.from('opportunities').insert(d);if(error)throw Error(error.message);keys.add(key);count++;
   }catch(e){skipped++;}}
  return {ok:true,count,skipped};
 }
 const userMatch=path.match(/^\/api\/users\/([\da-f-]{36})$/);
 if(userMatch&&method==='PATCH'){
  await neuRequireRole('admin');const changes={};
  if('role'in body){if(!['student','staff','admin'].includes(body.role))throw Error('Invalid role');changes.role=body.role;}
  if('active'in body)changes.active=!!body.active;
  if(!Object.keys(changes).length)throw Error('Only role and active status can be changed here. Create accounts and reset passwords in Supabase Authentication.');
  if(user.id===userMatch[1]&&(changes.role==='student'||changes.role==='staff'||changes.active===false))throw Error('You cannot remove your own admin access.');
  const {error}=await c.from('profiles').update(changes).eq('id',userMatch[1]);neuError(error);return {ok:true};
 }
 throw Error('This feature is not offered in the secure online version: '+path);
}
function neuDownloadExport(type){
 if(typeof state==='undefined'||!Array.isArray(state.opportunities))throw Error('Sign in to export records.');
 const rows=state.opportunities, keys=['title','country','region','sector','stakeholder','description','eligibility','funding','deadline','application_status','benefit','feasibility','relevance','risk','difficulty','score','priority','decision','action','verification','source_org','source_url','reviewer','last_verified'];
 let output,mime,filename;
 if(type==='csv'){
  const cell=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  output='\uFEFF'+keys.join(',')+'\r\n'+rows.map(r=>keys.map(k=>cell(r[k])).join(',')).join('\r\n');mime='text/csv;charset=utf-8';filename='neu-opportunities.csv';
 }else{output=JSON.stringify({exported_at:new Date().toISOString(),opportunities:rows},null,2);mime='application/json';filename='neu-opportunities.json';}
 const url=URL.createObjectURL(new Blob([output],{type:mime}));const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
}
function neuActivateRealtime(){
 const c=neuGetClient();if(neuChannel)return;
 const refresh=()=>{clearTimeout(neuRefreshHandle);neuRefreshHandle=setTimeout(()=>{if(typeof neuSoftRefresh==='function')neuSoftRefresh();},350);};
 neuChannel=c.channel('neu-opportunity-updates').on('postgres_changes',{event:'*',schema:'public',table:'opportunities'},refresh).on('postgres_changes',{event:'*',schema:'public',table:'app_settings'},refresh).subscribe();
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
 // Fallback ensures updates eventually appear even if WebSocket is disconnected.
 if(!neuPollingHandle)neuPollingHandle=setInterval(()=>{if(!document.hidden)refresh();},45000);
}
