/* GOID personalization & accessibility upgrade.
   Preserves legacy opportunity, role and assessment data. Requires ADDITIVE_GOOD_MIGRATION.sql.
   Auth/RLS decisions are always enforced by Supabase, never by this interface alone. */
'use strict';
const GOID_GROUPS=['Student','Educator','Researcher','Industry Professional','Entrepreneur / MSME Owner','Community Member'];
const GOID_TYPES=['Scholarships','Training','Internships','Research Grants','Exchange Programs','Partnerships','Business Funding','Trade / Export Programs','Community Development'];
const GOID_EXPENSES=['Registration / Application Fees','Travel','Accommodation','Other Participation Costs'];
const GOID_BENEFITS=['Financial Assistance','Skills Development','Research Support','Career Experience','Networking','Business Growth','International Exposure'];
const GOID_FORMATS=['Online','Face-to-Face','Hybrid'];
const GOID_DOCUMENTS=['Academic Records','Resume / CV','Portfolio / Proposal','Recommendation Letters','English Proficiency Proof','Passport'];
const GOID_METHODS=['Direct Application','School / Organization Nomination','Invitation-Based'];
const GOID_CATS=CATEGORIES.map(x=>x.id);
const GOID_Q=[
 {key:'users',name:'Which best describes you?',options:GOID_GROUPS,step:0},
 {key:'categories',name:'Which opportunity categories interest you?',options:GOID_CATS,step:0,labels:Object.fromEntries(CATEGORIES.map(x=>[x.id,x.short]))},
 {key:'types',name:'What opportunities are you looking for?',options:GOID_TYPES,step:0},
 {key:'countries',name:'Which countries interest you?',options:COUNTRIES,step:0},
 {key:'funding_coverage',name:'Which funding arrangements would you consider?',options:['Fully Funded','Partially Funded','Self-Funded'],step:1},
 {key:'expenses',name:'Which expenses can you cover?',options:[...GOID_EXPENSES,'None — I need support'],step:1,exclusive:['None — I need support']},
 {key:'benefits',name:'Which benefits matter to you?',options:GOID_BENEFITS,step:1},
 {key:'formats',name:'Which participation formats work for you?',options:GOID_FORMATS,step:2},
 {key:'documents',name:'Which application documents do you have?',options:[...GOID_DOCUMENTS,'None Yet'],step:2,exclusive:['None Yet']},
 {key:'timeline',name:'When do you plan to apply?',options:['As Soon As Possible','Within 3 Months','Within 6 Months','Just Exploring'],step:2,single:true},
 {key:'methods',name:'Which application methods are accessible to you?',options:[...GOID_METHODS,'Not Sure Yet'],step:2,exclusive:['Not Sure Yet']}
];
const GOID_M_META={
 intended_users:[...GOID_GROUPS,'All','Not Disclosed'],types:[...GOID_TYPES,'Not Disclosed'],
 funding_coverage:['Fully Funded','Partially Funded','Self-Funded','Not Disclosed'],
 expenses:[...GOID_EXPENSES,'None','Not Disclosed'],benefits:[...GOID_BENEFITS,'Not Disclosed'],
 formats:[...GOID_FORMATS,'Not Disclosed'],documents:[...GOID_DOCUMENTS,'Other Documents','Not Disclosed'],
 methods:[...GOID_METHODS,'Not Disclosed'],deadline_kind:['Fixed Deadline','No Fixed Deadline','Not Yet Announced']
};
const GOID_M_LABELS={intended_users:'Intended Users',types:'Opportunity Type',funding_coverage:'Funding Coverage',expenses:'Applicant Expenses',benefits:'Offered Benefits',formats:'Program Format',documents:'Required Documents',methods:'Application Method',deadline_kind:'Deadline Type'};
const GOID_KEYS=['users','categories','types','countries','funding_coverage','expenses','benefits','formats','documents','timeline','methods'];
state.preferences=null;
state.assistanceReads=[];
state.surveyAnswers={};
state.surveyActive=false;
state.surveySaving=false;
state.surveyStep=0;
state.browseMode='all';
state.showClosed=false;
state.moreFilters=false;
state.fundingFilter='';
state.formatFilter='';
state.showTop20=false;
state.tab='all';

// Extend the existing client API. In particular, these queries require the RLS rules
// installed by the additive migration; we do NOT silently store user data locally.
const goidOriginalApi=neuApi;
neuApi=async function(path,method='GET',body={}){
 const c=neuGetClient();
 if(path==='/api/preferences'&&method==='PUT'){
  const {user}=await neuRole('student');const answers=body.answers||{};
  if(Object.keys(answers).some(k=>!GOID_KEYS.includes(k)))throw Error('Unrecognized preference question.');
  for(const q of GOID_Q){const v=answers[q.key];
   if(q.single){if(!q.options.includes(v))throw Error('Choose your application timeline.');}
   else if(!Array.isArray(v)||!v.length||v.length>q.options.length||v.some(x=>!q.options.includes(x)))throw Error('Complete: '+q.name);
  }
  const {error}=await c.from('goid_user_preferences').upsert({user_id:user.id,answers,updated_at:new Date().toISOString()},{onConflict:'user_id'});neuFail(error);
  return {ok:true,answers};
 }
 if(path==='/api/assistance-seen'&&method==='POST'){
  const {user}=await neuRole('student');
  if(!Array.isArray(body.ids)||body.ids.length>500)throw Error('Invalid requests.');
  const ids=body.ids.filter(x=>/^[\da-f-]{36}$/i.test(x));
  if(ids.length){const {error}=await c.from('goid_assistance_reads').upsert(ids.map(id=>({user_id:user.id,request_id:id,seen_at:new Date().toISOString()})),{onConflict:'user_id,request_id'});neuFail(error);}
  return {ok:true};
 }
 const result=await goidOriginalApi(path,method,body);
 if(path==='/api/bootstrap'&&result?.authenticated){
  const [{data:p,error:e1},{data:r,error:e2}]=await Promise.all([
   c.from('goid_user_preferences').select('answers').eq('user_id',result.me.id).maybeSingle(),
   c.from('goid_assistance_reads').select('request_id,seen_at').eq('user_id',result.me.id)
  ]);
  if(e1||e2)throw Error('Personalization database update needed. Run ADDITIVE_GOOD_MIGRATION.sql first. '+(e1||e2).message);
  return {...result,preferences:p?.answers||null,assistanceReads:r||[]};
 }
 return result;
};

function goidCurrentAnswers(){return state.surveyActive?state.surveyAnswers:state.preferences||{};}
function goidMetadata(o){return o.match_data&&typeof o.match_data==='object'&&!Array.isArray(o.match_data)?o.match_data:{};}
function goidIsClosed(o){return /CLOSED|EXPIRED/i.test(o.application_status||'')||!!(o.deadline&&deadlineState(o)==='expired'&&goidMetadata(o).deadline_kind!=='No Fixed Deadline');}
function goidActive(){return published().filter(o=>!goidIsClosed(o));}
function goidDeadline(o){const m=goidMetadata(o);if(m.deadline_kind==='No Fixed Deadline')return 'No Fixed Deadline';if(o.deadline)return fmtDate(o.deadline);return 'Deadline Not Announced';}
function goidKnown(v){return v!==undefined&&v!==null&&v!==''&&!(Array.isArray(v)&&(!v.length||v.includes('Not Disclosed')))&&v!=='Not Disclosed';}
function goidMatch(o){
 const p=state.preferences||{},m=goidMetadata(o);
 if(!Object.keys(p).length)return {score:null,confidence:0,matched:[],notes:[],known:0};
 let earned=0,usable=0,known=0;const matched=[],notes=[];
 // All weights sum to 100. Missing data reduces confidence, not the score.
 const add=(weight,label,available,ok)=>{if(!available)return;usable+=weight;known++;if(ok){earned+=weight;matched.push(label);}else notes.push(label+' differs');};
 const overlaps=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.some(x=>b.includes(x));
 add(13,'Intended users',goidKnown(m.intended_users),m.intended_users?.includes('All')||overlaps(p.users,m.intended_users));
 add(15,'Category',!!o.sector,Array.isArray(p.categories)&&p.categories.includes(o.sector));
 add(14,'Opportunity type',goidKnown(m.types),overlaps(p.types,m.types));
 add(10,'Country',!!o.country,Array.isArray(p.countries)&&p.countries.includes(o.country));
 add(15,'Funding',goidKnown(m.funding_coverage),p.funding_coverage?.includes(m.funding_coverage));
 const noCost=Array.isArray(m.expenses)&&m.expenses.includes('None');
 const needsNone=p.expenses?.includes('None — I need support');
 add(10,'Applicant expenses',goidKnown(m.expenses),noCost||(!needsNone&&Array.isArray(m.expenses)&&m.expenses.every(x=>p.expenses?.includes(x))));
 add(10,'Benefits',goidKnown(m.benefits),overlaps(p.benefits,m.benefits));
 add(5,'Participation format',goidKnown(m.formats),overlaps(p.formats,m.formats));
 const noDocs=Array.isArray(m.documents)&&m.documents.includes('None');
 add(5,'Documents',goidKnown(m.documents),noDocs||(!p.documents?.includes('None Yet')&&m.documents?.every(x=>p.documents?.includes(x))));
 add(3,'Application method',goidKnown(m.methods),p.methods?.includes('Not Sure Yet')||overlaps(p.methods,m.methods));
 const confidence=Math.round(usable);
 // Prevent a misleading "100% match" from a record with only a country and category.
 const score=(usable>=35&&known>=4)?Math.round(earned/usable*100):null;
 return {score,confidence,matched,notes,known};
}
function goidMatchChip(o){const r=goidMatch(o);return r.score===null?'<span class="goid-match pending">Match pending · limited details</span>':`<span class="goid-match">✦ ${r.score}% match <small>· ${r.confidence}% info</small></span>`;}
function goidTimelinePriority(o){
 const p=state.preferences?.timeline||'';
 if(!o.deadline||p==='Just Exploring'||!p)return 0;
 const delta=Math.ceil((new Date(o.deadline+'T00:00:00')-new Date(new Date().toDateString()))/86400000);
 if(delta<0)return 0;
 const days=p==='As Soon As Possible'?30:p==='Within 3 Months'?90:180;
 return delta<=days?2:1;
}
function goidRank(){return goidActive().map(o=>({o,r:goidMatch(o)})).sort((a,b)=>(b.r.score??-1)-(a.r.score??-1)||b.r.confidence-a.r.confidence||goidTimelinePriority(b.o)-goidTimelinePriority(a.o)||(a.o.title||'').localeCompare(b.o.title||''));}
function goidTags(v){const a=Array.isArray(v)?v:(v?[v]:[]);return a.length?a.map(x=>`<span class="goid-tag">${escapeHTML(x)}</span>`).join(''):'<span class="muted">Not Disclosed</span>';}
function goidFieldValue(o,k){const m=goidMetadata(o);if(k==='country')return locationLabel(o);if(k==='deadline')return goidDeadline(o);if(k==='category')return cat(o.sector).short;if(k==='source')return o.source_org||'Not Disclosed';if(k==='requirements')return o.requirements||'Not Disclosed';if(k==='eligibility')return o.eligibility||'Not Disclosed';if(k==='funding_notes')return o.funding||'Not Disclosed';return Array.isArray(m[k])?m[k].join(', ')||'Not Disclosed':m[k]||'Not Disclosed';}

function goidCheckboxes(q,values,kind='survey'){
 const arr=Array.isArray(values)?values:[];
 return `<div class="goid-choice-grid">${q.options.map(o=>`<label class="goid-choice"><input type="${q.single?'radio':'checkbox'}" name="${escapeHTML(q.key)}" data-goid-key="${escapeHTML(q.key)}" value="${escapeHTML(o)}" ${(q.single?values===o:arr.includes(o))?'checked':''}><span>${escapeHTML(q.labels?.[o]||o)}</span></label>`).join('')}</div>`;
}
function goidSurveyHTML(){
 const step=state.surveyStep,headers=[['About You','Your interests and destinations'],['Funding & Benefits','What matters most to you'],['Participation & Application','How you prefer to apply']];
 return `<section id="goid-wizard" class="goid-survey">
  <div class="goid-survey-head"><span class="goid-sparkle">✦</span><span class="eyebrow">NEU GOID · A LITTLE ABOUT YOU</span></div>
  <h1>Let's find opportunities for you <span>♡</span></h1><p class="muted">Tell us what fits your goals. You can change these answers anytime from Overview.</p>
  <div class="goid-steps"><span class="${step>=0?'active':''}"></span><span class="${step>=1?'active':''}"></span><span class="${step>=2?'active':''}"></span></div>
  <div class="goid-step-title"><div><strong>Step ${step+1} of 3 — ${headers[step][0]}</strong><small>${headers[step][1]}</small></div><span class="goid-soft-badge">Choose all that apply ✨</span></div>
  ${GOID_Q.filter(q=>q.step===step).map(q=>`<fieldset class="goid-question"><legend>${GOID_Q.indexOf(q)+1}. ${escapeHTML(q.name)} ${q.single?'<span class="muted small">(Choose one)</span>':''}</legend>${goidCheckboxes(q,state.surveyAnswers[q.key]||[], 'survey')}</fieldset>`).join('')}
  <div class="goid-wizard-bottom">${state.preferences?`<button class="btn light" type="button" data-goid-action="survey-cancel">Cancel</button>`:''}<button class="btn light" type="button" data-goid-action="survey-back" ${step===0?'disabled':''}>← Back</button><button class="btn primary" type="button" data-goid-action="survey-next">${step===2?'Find My Opportunities ✨':'Continue →'}</button></div>
  <p class="muted tiny">Survey answers personalize recommendations only. You can still browse ALL approved opportunities.</p>
 </section>`;
}
function goidSaveStep(){const questions=GOID_Q.filter(q=>q.step===state.surveyStep);
 for(const q of questions){const values=Array.from(document.querySelectorAll('#goid-wizard [name="'+q.key+'"]:checked')).map(el=>el.value);
  if(!values.length){toast('Please answer: '+q.name,true);return false;}
  state.surveyAnswers[q.key]=q.single?values[0]:values;
 }
 return true;
}
async function goidCompleteSurvey(){
 if(!goidSaveStep()||state.surveySaving)return;
 state.surveySaving=true;
 const holder=$('#app-view');holder.innerHTML=`<section class="goid-loading" role="status" aria-live="polite"><div class="goid-loading-globe">🌏</div><div class="goid-loading-stars">✦ ✧ ✦</div><h1>Finding opportunities just for you...</h1><p>Saving your preferences and preparing your matches ♡</p><div class="goid-progress"><span></span></div></section>`;
 try{
  const result=await neuApi('/api/preferences','PUT',{answers:state.surveyAnswers});
  state.preferences=result.answers;state.surveyActive=false;state.surveySaving=false;state.page='overview';state.showTop20=false;
  navigation();render();window.scrollTo(0,0);
  toast('Your personalized opportunities are ready! ✨');
 }catch(e){state.surveySaving=false;render();toast('Could not save your survey: '+e.message,true);}
}

// ---- User pages: fewer controls, richer decisions, complete detail text ----
const goidOriginalNavigate=navigate;
navigate=function(page){
 goidOriginalNavigate(page);
 if(page==='explore'){state.tab='all';state.browseMode='all';state.showClosed=false;state.moreFilters=false;state.sort='match';render();}
};
const goidOriginalNavigation=navigation;
navigation=function(){
 goidOriginalNavigation();
 const nav=$('#primary-nav');if(!nav)return;
 const insight=nav.querySelector('[data-page="insights"]');if(insight)insight.textContent=state.me?.role==='student'?'✦  My rankings':'◫  Insights';
 const explore=nav.querySelector('[data-page="explore"]');if(explore)explore.textContent='◈  Discover opportunities';
 const assistance=nav.querySelector('[data-page="requests"]');if(assistance){const count=goidUnread();assistance.innerHTML=`<span class="nav-ico">✉</span>My assistance${count?` <span class="goid-unread">${count>99?'99+':count}</span>`:''}`;}
};
function goidUnread(){
 if(!state.me)return 0;
 if(state.me.role!=='student')return state.requests.filter(r=>r.status==='NEW').length;
 const reads=new Map((state.assistanceReads||[]).map(r=>[r.request_id,r.seen_at]));
 return state.requests.filter(r=>r.requester_id===state.me.id&&(r.status!=='NEW'||r.staff_reply)&&(!reads.get(r.id)||new Date(r.updated_at).getTime()>new Date(reads.get(r.id)).getTime()+1000)).length;
}
function goidMetric(label,value,icon,page,filter=''){
 return `<button type="button" class="goid-stat" data-goid-action="metric" data-page="${page}" data-filter="${escapeHTML(filter)}"><span><small>${escapeHTML(label)}</small><strong>${escapeHTML(value)}</strong></span><span class="goid-stat-ico">${icon}</span></button>`;
}
function goidOverview(){
 const rows=goidActive(),soon=rows.filter(o=>deadlineState(o)==='soon').length;
 const rank=goidRank(),matchCount=rank.filter(x=>x.r.score!==null&&x.r.score>=60).length;
 const countries=COUNTRIES.map(c=>({n:c,v:rows.filter(o=>o.country===c).length}));
 const role=state.me?.role||'student',prefs=state.preferences||{};
 const display=(key)=>Array.isArray(prefs[key])?prefs[key].map(x=>key==='categories'?cat(x).short:x).join(' · '):'';
 const ranked=rank.slice(0,10);
 return `<section class="goid-hero"><div><span class="eyebrow">✦ NEU GLOBAL OPPORTUNITY INTELLIGENCE DASHBOARD</span><h1>Discover your next possibility <span>✧</span></h1><p>${role==='student'?'Matched to your interests, with every verified opportunity still open for exploration.':'Source-linked opportunity records, approvals, and smarter discovery for the GOID research team.'}</p><button type="button" class="btn primary" data-action="nav" data-page="explore">Discover all opportunities →</button></div><span class="goid-hero-emoji">🌏</span></section>
 ${role==='student'?`<section class="goid-preferences"><div class="goid-panel-head"><div><h2>✦ Your Preferences</h2><p>Based on your onboarding survey</p></div><button class="btn sm soft" type="button" data-goid-action="change-survey">✎ Change My Preferences</button></div><div class="goid-pref-chips">${['categories','countries','funding_coverage'].flatMap(k=>Array.isArray(prefs[k])?prefs[k]:[]).slice(0,9).map(x=>`<span class="goid-tag">${escapeHTML(GOID_CATS.includes(x)?cat(x).short:x)}</span>`).join('')}</div><p class="muted tiny">Changing your preferences updates matching and rankings, not the underlying opportunity assessments.</p></section>`:''}
 <div class="goid-stats">${goidMetric('Active opportunities',rows.length,'🌍','explore')}${goidMetric(role==='student'?'Matching opportunities':'Pending approvals',role==='student'?matchCount:state.opportunities.filter(o=>o.verification==='PENDING VERIFICATION').length,'✦',role==='student'?'insights':'manage')}${goidMetric('Upcoming deadlines',soon,'🗓','explore','soon')}${goidMetric(role==='student'?'Saved opportunities':'Assistance requests',role==='student'?state.bookmarks.length:state.requests.filter(x=>x.status!=='RESOLVED').length,'♡',role==='student'?'saved':'manage')}</div>
 ${role==='student'?`<div class="section-heading"><h2>Your Top 10 Matches ✨</h2><button class="btn sm soft" type="button" data-action="nav" data-page="insights">See Top 20 →</button></div><div class="goid-ranked-small">${ranked.length?ranked.map((x,i)=>`<button type="button" class="goid-rank-tile" data-action="detail" data-id="${x.o.id}"><span class="position">${i+1}</span><div><b>${escapeHTML(x.o.title)}</b><small>${escapeHTML(cat(x.o.sector).short)} · ${escapeHTML(x.o.country)}</small></div>${goidMatchChip(x.o)}<span class="goid-rank-arrow">↗</span></button>`).join(''):'<div class="empty">No active opportunities yet.</div>'}</div>`:''}
 <div class="section-heading"><h2>Explore the opportunity landscape</h2><p>Click a category or country to discover relevant listings</p></div>
 <div class="chart-duo"><section class="soft-panel"><h3>🧁 By category</h3>${CATEGORIES.map(c=>`<button type="button" class="goid-chart-row" data-goid-action="filter-category" data-sector="${escapeHTML(c.id)}"><span>${c.icon} ${escapeHTML(c.short)}</span><span class="goid-chart-track"><span style="width:${Math.round(rows.filter(o=>o.sector===c.id).length/Math.max(1,rows.length)*100)}%;background:${c.color}"></span></span><b>${rows.filter(o=>o.sector===c.id).length}</b></button>`).join('')}</section>
 <section class="soft-panel"><h3>🌏 By location</h3>${countries.map(c=>`<button type="button" class="goid-chart-row" data-goid-action="filter-country" data-country="${escapeHTML(c.n)}"><span>${FLAGS[c.n]} ${escapeHTML(c.n)}</span><span class="goid-chart-track"><span style="width:${Math.round(c.v/Math.max(1,...countries.map(y=>y.v))*100)}%"></span></span><b>${c.v}</b></button>`).join('')}</section></div>
 <p class="muted small goid-disclaimer">Matches are estimates based on user preferences and published information. Always confirm deadlines, eligibility, and financial details with the official provider. GOID remains an academic prototype.</p>`;
}
function goidOpportunityCard(o){
 const match=goidMatch(o),m=goidMetadata(o);
 return `<article class="card-op ${cat(o.sector).accent} goid-card"><div class="card-op-top">${categoryTag(o.sector)}${appChip(o)}</div><h3>${escapeHTML(o.title)}</h3><p class="muted small">📍 ${escapeHTML(locationLabel(o))} · ${escapeHTML(o.source_org||'Source not specified')}</p><p class="goid-clamp">${escapeHTML(o.description||'Please consult the official program information.')}</p><div class="goid-tags-row"><span class="goid-tag">${escapeHTML(m.funding_coverage||'Funding: not disclosed')}</span><span class="goid-tag">🗓 ${escapeHTML(goidDeadline(o))}</span></div><div class="card-op-footer">${goidMatchChip(o)}<div class="card-actions"><button class="btn sm light" type="button" data-action="bookmark" data-id="${o.id}" aria-label="${saved(o.id)?'Unsave':'Save'}">${saved(o.id)?'♥':'♡'}</button><button class="btn sm light" type="button" data-action="compare-add" data-id="${o.id}" title="Compare">⇄</button><button class="btn sm soft" type="button" data-action="detail" data-id="${o.id}">View Details</button></div></div></article>`;
}
function goidExplored(){
 let rows=published().filter(o=>state.showClosed||!goidIsClosed(o));
 if(state.tab&&state.tab!=='all')rows=rows.filter(o=>o.sector===state.tab);
 if(state.query){const q=state.query.toLowerCase().trim();rows=rows.filter(o=>[o.title,o.description,o.source_org,o.country,o.region,goidFieldValue(o,'types')].join(' ').toLowerCase().includes(q));}
 if(state.country)rows=rows.filter(o=>o.country===state.country);
 if(state.region)rows=rows.filter(o=>o.region===state.region);
 if(state.fundingFilter)rows=rows.filter(o=>goidMetadata(o).funding_coverage===state.fundingFilter);
 if(state.formatFilter)rows=rows.filter(o=>goidMetadata(o).formats?.includes(state.formatFilter));
 if(state.browseMode==='you')rows=rows.filter(o=>goidMatch(o).score!==null&&goidMatch(o).score>=40);
 const score=(o)=>goidMatch(o).score??-1;
 rows.sort((a,b)=>state.sort==='deadline'?(a.deadline||'9999').localeCompare(b.deadline||'9999'):state.sort==='recent'?(b.created_at||'').localeCompare(a.created_at||''):score(b)-score(a)||((b.created_at||'').localeCompare(a.created_at||'')));
 return rows;
}
function goidExplore(){
 return heading('DISCOVER','Discover opportunities 🌏','Browse every approved listing, or focus on opportunities matched to your preferences.')+`
 <div class="goid-filter-shell"><div class="goid-switch"><button class="${state.browseMode==='all'?'selected':''}" type="button" data-goid-action="browse-mode" data-mode="all">All Opportunities</button><button class="${state.browseMode==='you'?'selected':''}" type="button" data-goid-action="browse-mode" data-mode="you">For You ✨</button></div>
 <div class="goid-toolbar"><label class="goid-search"><span>⌕</span><input id="query" type="search" aria-label="Search opportunities" value="${escapeHTML(state.query)}" placeholder="Search opportunities..."></label><button type="button" class="btn sm light" data-goid-action="toggle-filters">☷ Filters ${state.moreFilters?'−':'+'}</button></div>
 <div class="goid-categories"><button type="button" data-goid-action="choose-category" data-sector="all" class="${state.tab==='all'?'active':''}">All</button>${CATEGORIES.map(c=>`<button type="button" data-goid-action="choose-category" data-sector="${escapeHTML(c.id)}" class="${state.tab===c.id?'active':''}"><span style="color:${c.color}">●</span> ${escapeHTML(c.short)}</button>`).join('')}</div>
 ${state.moreFilters?`<div class="goid-extra-filters"><label>Country<select id="country"><option value="">All countries</option>${COUNTRIES.map(c=>`<option value="${escapeHTML(c)}" ${state.country===c?'selected':''}>${escapeHTML(c)}</option>`).join('')}</select></label><label>Philippine region<select id="region" ${state.country!=='Philippines'?'disabled':''}><option value="">All regions</option>${PH_REGIONS.map(r=>`<option ${r===state.region?'selected':''} value="${escapeHTML(r)}">${escapeHTML(r)}</option>`).join('')}</select></label><label>Funding<select id="goid-funding"><option value="">Any funding</option>${GOID_M_META.funding_coverage.map(f=>`<option ${f===state.fundingFilter?'selected':''}>${escapeHTML(f)}</option>`).join('')}</select></label><label>Format<select id="goid-format"><option value="">Any format</option>${GOID_FORMATS.map(f=>`<option ${f===state.formatFilter?'selected':''}>${escapeHTML(f)}</option>`).join('')}</select></label><label class="goid-closed-toggle"><input id="goid-closed" type="checkbox" ${state.showClosed?'checked':''}> Include Closed Opportunities</label></div>`:''}</div></div>
 <div class="goid-results-bar"><span id="result-count" aria-live="polite"></span><label>Sort by <select id="sort"><option value="match" ${state.sort==='match'?'selected':''}>Best match</option><option value="deadline" ${state.sort==='deadline'?'selected':''}>Soonest deadline</option><option value="recent" ${state.sort==='recent'?'selected':''}>Newest</option></select></label></div><div id="explore-list" class="ui-grid"></div>`;
}
function goidUpdateExplore(){const el=$('#explore-list'),count=$('#result-count');if(!el||!count)return;const rows=goidExplored();count.textContent=`${rows.length} opportunit${rows.length===1?'y':'ies'} found`;el.innerHTML=rows.length?rows.map(goidOpportunityCard).join(''):`<div class="empty"><strong>No matching opportunities found</strong>Try All Opportunities or loosen your filters. Older records may not yet have enough matching details.</div>`;}
function goidRankings(){const rank=goidRank(),shown=rank.slice(0,state.showTop20?20:10),p=state.preferences||{};
 return heading('PERSONALIZED','Your opportunity rankings ✨','Ranked for you using your saved preferences and documented program information.',`<button type="button" class="btn soft" data-goid-action="change-survey">Change My Preferences</button>`)+`
 <div class="alert-banner purple">A high match means a closer fit to your preferences — it does not guarantee admission, eligibility, or funding. Match pending means not enough verified matching details are available.</div>
 <div class="goid-ranked-small">${shown.length?shown.map((x,i)=>`<button type="button" class="goid-rank-tile" data-action="detail" data-id="${x.o.id}"><span class="position">${i+1}</span><div><b>${escapeHTML(x.o.title)}</b><small>${escapeHTML(cat(x.o.sector).short)} · ${escapeHTML(x.o.country)} · ${escapeHTML(goidDeadline(x.o))}</small></div>${goidMatchChip(x.o)}<span>↗</span></button>`).join(''):'<div class="empty">No active opportunities yet.</div>'}</div>
 ${rank.length>10?`<div class="goid-center"><button type="button" class="btn soft" data-goid-action="top-toggle">${state.showTop20?'Show Top 10':'See Top 20 Rankings →'}</button></div>`:''}
 <p class="muted tiny">${Math.min(rank.length,state.showTop20?20:10)} of ${rank.length} active opportunities shown. See Discover for the full directory.</p>`;
}
function goidCompare(){
 const rows=state.compare.map(opp).filter(o=>o&&o.verification==='VERIFIED'&&!o.archived);
 const available=published().filter(o=>!rows.some(x=>x.id===o.id));
 const values=[['Country / location','country'],['Category','category'],['Intended users','intended_users'],['Opportunity type','types'],['Funding coverage','funding_coverage'],['Applicant expenses','expenses'],['Offered benefits','benefits'],['Program format','formats'],['Required documents','documents'],['Application method','methods'],['Eligibility','eligibility'],['Requirements','requirements'],['Deadline','deadline']];
 const columns=rows.length;
 return heading('COMPARE','Compare opportunities ↔','Choose up to three opportunities, spot differences, and decide what fits you.')+`
 <div class="goid-compare-toolbar"><select id="compare-add" aria-label="Add an opportunity to comparison" ${columns>=3?'disabled':''}><option value="">Add an opportunity...</option>${available.map(o=>`<option value="${o.id}">${escapeHTML(clip(o.title,90))}</option>`).join('')}</select><button class="btn sm light" type="button" data-action="clear-compare" ${!columns?'disabled':''}>Clear</button><span class="muted small">${columns} / 3 selected</span></div>
 ${columns?`<div class="goid-comparison-scroll"><table class="goid-comparison"><thead><tr><th>Compare</th>${rows.map(o=>`<th><div class="goid-compare-head">${categoryTag(o.sector)}<b>${escapeHTML(o.title)}</b>${goidMatchChip(o)}<button class="btn sm light" data-action="compare-remove" data-id="${o.id}">Remove</button><button class="btn sm soft" data-action="detail" data-id="${o.id}">View Details</button></div></th>`).join('')}</tr></thead><tbody>${values.map(([label,k])=>{const vv=rows.map(o=>goidFieldValue(o,k)),different=new Set(vv).size>1;return `<tr class="${different?'different':''}"><th>${escapeHTML(label)}${different?' <span title="Different values">✦</span>':''}</th>${vv.map(v=>`<td>${escapeHTML(v)}</td>`).join('')}</tr>`;}).join('')}</tbody></table></div>`:'<div class="empty"><strong>No opportunities selected yet</strong>Add an opportunity above or use Compare on any opportunity card.</div>'}
 <p class="muted small" style="margin-top:14px">Highlighted rows show differences. Unknown information is never assumed to be free, eligible or available.</p>`;
}
function goidSaved(){const rows=published().filter(o=>saved(o.id));return heading('SAVED','Saved opportunities ♡','Your bookmarked opportunities, including closed listings with an appropriate status label.')+`<div class="ui-grid">${rows.length?rows.map(goidOpportunityCard).join(''):'<div class="empty">No saved opportunities yet. Save any opportunity from Discover.</div>'}</div>`;}
function goidTextBlock(label,value){return `<div class="goid-detail-text"><h3>${escapeHTML(label)}</h3><p>${escapeHTML(value||'Not Disclosed')}</p></div>`;}
function goidDetailField(title,value){return `<div class="goid-detail-cell"><small>${escapeHTML(title)}</small><div>${Array.isArray(value)?goidTags(value):escapeHTML(value||'Not Disclosed')}</div></div>`;}
function goidDetails(id){
 const o=opp(id);if(!o)return;const m=goidMetadata(o),match=goidMatch(o),role=state.me?.role;
 const link=(url,label,cls='soft')=>neuLink(url)?`<a class="btn ${cls}" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)} ↗</a>`:'';
 const evidence=roleAtLeast('staff')?`<details class="goid-admin-evidence"><summary>Internal evidence review (Staff/Admin only)</summary><div>${(o.assessment?.lines||[]).filter(l=>l.key!=='risk').map(l=>`<div class="evidence-row"><div><b>${escapeHTML(l.label)}</b><br><span>${escapeHTML(l.description)}</span></div><div>${l.rating?l.rating+' / 5':'Not assessed'}${neuLink(l.source_url)?`<br><a target="_blank" rel="noopener noreferrer" href="${escapeHTML(l.source_url)}">Evidence ↗</a>`:''}</div></div>`).join('')}</div><p class="muted tiny">Evidence completeness: ${Number(o.assessment?.completeness||0)}%. Historical risk details are retained in the database.</p></details>`:'';
 showModal(`<div class="goid-details">${modalHeader(o.title,'GOID Opportunity Details')}<div class="goid-details-banner">${categoryTag(o.sector)}${appChip(o)}${goidMatchChip(o)}<p>📍 ${escapeHTML(locationLabel(o))} · ${escapeHTML(o.source_org||'Official organization not specified')}</p></div>
 <section class="goid-detail-section"><h3>✦ About this opportunity</h3><p class="goid-full-text">${escapeHTML(o.description||'Please consult the official source for the opportunity description.')}</p></section>
 <div class="goid-detail-grid">${goidDetailField('Intended users',m.intended_users?.length?m.intended_users:({'Students':['Student'],'Faculty & Researchers':['Educator','Researcher'],'MSMEs & Entrepreneurs':['Entrepreneur / MSME Owner','Community Member']}[o.stakeholder]||['Not Disclosed']))}${goidDetailField('Opportunity type',m.types)}${goidDetailField('Funding coverage',m.funding_coverage)}${goidDetailField('Applicant expenses',m.expenses)}${goidDetailField('Offered benefits',m.benefits)}${goidDetailField('Program format',m.formats)}${goidDetailField('Application method',m.methods)}${goidDetailField('Application deadline',goidDeadline(o))}${goidDetailField('Last verified',o.last_verified?fmtDate(o.last_verified):'Not recorded')}${goidDetailField('Required documents',m.documents)}</div>
 ${goidTextBlock('Eligibility & who can apply',o.eligibility)}${goidTextBlock('Application requirements',o.requirements)}${goidTextBlock('Funding and benefit details',o.funding)}${roleAtLeast('admin')?goidDetailField('Project decision status (Admin only)',o.decision||'INVESTIGATE FURTHER'):''}
 <section class="goid-detail-section"><h3>✧ Why this opportunity appears for you</h3>${match.score===null?`<p class="muted small">More matching information is needed before GOID can estimate a reliable match. You can still read the official details and apply independently.</p>`:`<p class="goid-match-explain"><b>${match.score}% preference match</b> · ${match.confidence}% matching information available</p><div class="goid-pref-chips">${match.matched.map(s=>`<span class="goid-tag">✓ ${escapeHTML(s)}</span>`).join('')||'<span class="muted">No currently confirmed matching factors.</span>'}</div>`}<p class="muted tiny">This is not an eligibility decision or application approval. The matching formula is managed internally.</p></section>
 ${evidence}
 <div class="goid-detail-actions">${link(o.source_url,'Official Source','primary')}${!goidIsClosed(o)?link(o.application_url,'Apply / Application Portal'):''}${link(o.contact_url,'Contact Provider')}<button class="btn light" type="button" data-action="bookmark" data-id="${o.id}">${saved(o.id)?'♥ Saved':'♡ Save'}</button><button class="btn light" type="button" data-action="compare-add" data-id="${o.id}">⇄ Compare</button><button class="btn soft" type="button" data-action="request" data-id="${o.id}">✉ Request Assistance</button><button class="btn light" type="button" data-action="report" data-id="${o.id}">⚑ Report an Issue</button></div>
 <p class="muted tiny">GOID is an academic project prototype. Confirm all details with the official opportunity provider.</p></div>`,true);
}

// ---- More structured, evidence-linked Staff/Admin opportunity form ----
const goidOriginalCollectRecord=collectRecord;
function goidArea(name,label,val='',required=false,limit=180){
 const max=Math.max(limit,String(val||'').length);return `<div class="form-input wide"><label for="f-${name}">${escapeHTML(label)}</label><textarea id="f-${name}" name="${name}" rows="${name==='requirements'?5:3}" maxlength="${max}" ${required?'required':''}>${escapeHTML(val)}</textarea><small class="goid-count">${String(val||'').length} / ${max} characters</small></div>`;
}
function goidMetaCheck(key,label,val,required=true){
 const opts=GOID_M_META[key],active=Array.isArray(val)?val:[];
 return `<fieldset class="goid-meta-field"><legend>${escapeHTML(label)}${required?' *':''}</legend><div class="goid-choice-grid compact">${opts.map(x=>`<label class="goid-choice"><input type="checkbox" name="m_${key}" value="${escapeHTML(x)}" ${active.includes(x)?'checked':''}><span>${escapeHTML(x)}</span></label>`).join('')}</div></fieldset>`;
}
function goidMetaSelect(key,label,val){return select('m_'+key,label,GOID_M_META[key],val||GOID_M_META[key].at(-1),true);}
function goidEvidenceFields(o){
 const pretty={benefit:'Potential benefit',feasibility:'Feasibility / access',relevance:'Strategic relevance',difficulty:'Application difficulty'};
 return ['benefit','feasibility','relevance','difficulty'].map(k=>{
  const old=o?.evidence?.[k]||{},official=old.source_url||o?.source_url||'';
  return `<div class="goid-evidence"><label>${escapeHTML(pretty[k])}<select name="e_${k}" id="e-${k}"><option value="">Not Assessed — insufficient official evidence</option>${NEU_RUBRIC[k].map(([code,desc,rating])=>`<option ${old.code===code?'selected':''} value="${escapeHTML(code)}">${rating} — ${escapeHTML(desc)}</option>`).join('')}</select></label>${field('url_'+k,'Official evidence link',official,'url',false,'placeholder="https://…"')}<p class="muted tiny">Use the official link only if it actually supports the selected statement.</p></div>`;
 }).join('');
}
function goidEditOpportunity(id){
 if(!roleAtLeast('staff'))return;
 const o=id?opp(id):null,m=goidMetadata(o||{});
 const r=o||{title:'',sector:CATEGORIES[0].id,country:'Philippines',region:'',description:'',funding:'',eligibility:'',requirements:'',deadline:'',source_org:'',source_url:'',application_url:'',contact_url:'',application_status:'OPEN',evidence:{},stakeholder:'Students'};
 const proposal=!!(o&&o.verification==='VERIFIED'&&!roleAtLeast('admin'));
 const deadlineKind=m.deadline_kind||(r.deadline?'Fixed Deadline':'Not Yet Announced');
 const statuses=['OPEN','CLOSED','ONGOING PROGRAM','UPCOMING'];
 if(o?.application_status&&!statuses.includes(o.application_status))statuses.unshift(o.application_status);
 showModal(`${modalHeader(o?(proposal?'Propose an edit':'Edit opportunity'):'Add opportunity',proposal?'Changes to published listings need Admin approval.':'All matching selections must reflect the official source.')}
 <form id="record-form" data-id="${o?.id||''}"><div class="goid-form-intro">✦ Structured selections appear in Opportunity Details and power user matches. Select <b>Not Disclosed</b> when a source does not provide an answer.</div>
 <div class="goid-form-heading">01 · Basic information</div><div class="form-two">
 ${field('title','Opportunity title',r.title,'text',true,'maxlength="180"')}${select('sector','Opportunity category',CATEGORIES.map(c=>[c.id,c.short]),r.sector,true)}
 ${select('country','Country',COUNTRIES,r.country,true)}<div id="goid-ph-region">${select('region','Philippine region',[['','Select region or Nationwide'],...PH_REGIONS],r.region,r.country==='Philippines')}</div>
 ${select('application_status','Application status',statuses,r.application_status,true)}${field('source_org','Official source organization',r.source_org,'text',true,'maxlength="180"')}
 ${field('source_url','Official website / evidence link',r.source_url,'url',true)}${field('application_url','Application portal (optional)',r.application_url,'url')}
 ${field('contact_url','Official contact (optional)',r.contact_url,'url')}${goidMetaSelect('deadline_kind','Deadline type',deadlineKind)}
 <div id="goid-date-container">${field('deadline','Deadline (fixed date only)',r.deadline,'date',deadlineKind==='Fixed Deadline')}</div>
 </div>
 <div class="goid-form-heading">02 · Matching details</div>
 ${goidMetaCheck('intended_users','Intended users',m.intended_users||[])}${goidMetaCheck('types','Opportunity type / purpose',m.types||[])}
 <div class="form-two">${goidMetaSelect('funding_coverage','Funding coverage',m.funding_coverage||'Not Disclosed')}</div>
 ${goidMetaCheck('expenses','Expenses applicants must cover',m.expenses||[])}${goidMetaCheck('benefits','Offered benefits',m.benefits||[])}
 ${goidMetaCheck('formats','Participation format',m.formats||[])}${goidMetaCheck('documents','Required documents',m.documents||[])}${goidMetaCheck('methods','Application method',m.methods||[])}
 <div class="goid-form-heading">03 · Written details</div>
 <div class="form-two">${goidArea('description','Short opportunity description',r.description,true,180)}${goidArea('eligibility','Eligibility summary',r.eligibility,true,280)}${goidArea('funding','Funding notes (optional)',r.funding,false,300)}${goidArea('requirements','Complete requirements',r.requirements,true,4000)}</div>
 <div class="goid-form-heading">04 · Evidence-based assessment <small>(Staff/Admin)</small></div>
 <div class="alert-banner purple">Select only what can be supported by the official source. Not Assessed does not mean zero. Historical risk assessments remain stored, but risks are no longer requested in this form.</div>
 <div class="goid-evidence-grid">${goidEvidenceFields(r)}</div><div id="score-preview" class="assessment-note"></div>
 ${roleAtLeast('admin')&&o?`<div class="goid-form-heading">05 · Project decision status <small>(Admin only)</small></div><div class="form-two">${select('decision','Project decision status',['INVESTIGATE FURTHER','MONITOR','PURSUE','REJECT'],r.decision||'INVESTIGATE FURTHER')}</div>`:''}
 <div class="footer-buttons"><button type="button" class="btn light" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${proposal?'Submit for Admin Review':o?'Save Changes':'Submit Opportunity'}</button></div></form>`,true);
 goidToggleFormFields();updateEvidencePreview();
}
function goidToggleFormFields(){const f=$('#record-form');if(!f)return;
 const country=f.elements.country?.value,region=f.elements.region,wrap=$('#goid-ph-region');
 if(wrap){wrap.hidden=country!=='Philippines';region.disabled=country!=='Philippines';region.required=country==='Philippines';if(country!=='Philippines')region.value='';}
 const fixed=f.elements.m_deadline_kind?.value==='Fixed Deadline',dateWrap=$('#goid-date-container');
 if(dateWrap){dateWrap.hidden=!fixed;f.elements.deadline.required=fixed;if(!fixed)f.elements.deadline.value='';}
}
collectRecord=function(form){
 const record=goidOriginalCollectRecord(form),m={};
 for(const [key,opts] of Object.entries(GOID_M_META)){
  if(key==='funding_coverage'||key==='deadline_kind')m[key]=form.elements['m_'+key]?.value||'';
  else m[key]=Array.from(form.querySelectorAll('[name="m_'+key+'"]:checked')).map(x=>x.value);
  if((Array.isArray(m[key])&&!m[key].length)||!m[key])throw Error('Complete the '+GOID_M_LABELS[key]+' field. Select Not Disclosed if the source does not specify it.');
  if(Array.isArray(m[key])&&m[key].includes('Not Disclosed')&&m[key].length>1)throw Error('Not Disclosed cannot be combined with other selections in '+GOID_M_LABELS[key]+'.');
 }
 if(m.deadline_kind==='Fixed Deadline'&&!form.elements.deadline?.value)throw Error('Select the fixed application deadline.');
 if(m.deadline_kind!=='Fixed Deadline')record.deadline=null;
 for(const key of Object.keys(record))if(key.startsWith('m_'))delete record[key];
 // Preserve historic evidence, including old risk entries not displayed in the new form.
 const old=opp(form.dataset.id);
 const merged={...(old?.evidence||{})};
 // Current criteria must support both replacement and deliberate clearing to Not Assessed.
 for(const k of ['benefit','feasibility','relevance','difficulty']){
  if(record.evidence?.[k])merged[k]=record.evidence[k];else delete merged[k];
 }
 record.evidence=merged; // retains historic risk evidence without showing an editable risk field
 record.match_data=m;
 // This is a backwards-compatible legacy column. Actual intended users live in match_data.
 record.stakeholder=old?.stakeholder||({[CATEGORIES[0].id]:'Students',[CATEGORIES[1].id]:'Faculty & Researchers',[CATEGORIES[2].id]:'MSMEs & Entrepreneurs',[CATEGORIES[3].id]:'MSMEs & Entrepreneurs'}[record.sector]||'Students');
 if(!String(record.requirements||'').trim())throw Error('Application requirements are required. If unknown, state that they are not disclosed by the official source.');
 return record;
};

// Bind the new views into the existing routing shell without changing authentication.
function goidStaffInsights(){
 const rows=goidActive(),assessed=rows.filter(o=>o.score!==null),rank=[...rows].sort((a,b)=>(b.score??-1)-(a.score??-1));
 return heading('TEAM INSIGHTS','Active opportunity insights','Assessment monitoring and records ready for verification.')+
  `<div class="goid-stats">${goidMetric('Active opportunities',rows.length,'🌏','explore')}${goidMetric('With rubric evidence',assessed.length,'✓','manage')}${goidMetric('Need more evidence',rows.length-assessed.length,'✎','manage')}${goidMetric('Pending approvals',state.opportunities.filter(o=>o.verification==='PENDING VERIFICATION').length,'⏳','manage')}</div><div class="section-heading"><h2>Active records — internal evidence review</h2><p>Closed opportunities are excluded. Missing evidence is never zero.</p></div><div class="goid-ranked-small">${rank.length?rank.slice(0,20).map((o,i)=>`<button class="goid-rank-tile" type="button" data-action="detail" data-id="${o.id}"><span class="position">${i+1}</span><div><b>${escapeHTML(o.title)}</b><small>${escapeHTML(o.country)} · ${escapeHTML(cat(o.sector).short)}</small></div><span class="muted small">${o.score===null?'Not assessed':Number(o.score).toFixed(1)+'/100'} · ${o.assessment?.completeness||0}% evidence</span></button>`).join(''):'<div class="empty">No active published records.</div>'}</div>`;
}
const goidOriginalInsights=renderInsights;
renderOverview=goidOverview;
renderExplore=goidExplore;
updateExplore=goidUpdateExplore;
renderInsights=function(){return state.me?.role==='student'?goidRankings():goidStaffInsights();};
renderCompare=goidCompare;
renderSaved=goidSaved;
details=goidDetails;
editOpportunity=goidEditOpportunity;
const goidOriginalGuide=guide;
guide=function(){if(state.me?.role!=='student')return goidOriginalGuide();
 showModal(`${modalHeader('Quick GOID guide','Find and compare relevant opportunities')}<div class="rank-list"><div class="rank-item">✦ <div class="rank-main"><b>Your Overview</b><small>Explore your Top 10 matches and change survey preferences anytime.</small></div></div><div class="rank-item">🌏 <div class="rank-main"><b>Discover</b><small>All Opportunities shows every active listing. For You focuses on preferences.</small></div></div><div class="rank-item">↔ <div class="rank-main"><b>Compare</b><small>Compare up to three opportunities side-by-side.</small></div></div><div class="rank-item">♡ <div class="rank-main"><b>Save and ask for assistance</b><small>Bookmark records and check replies under My Assistance.</small></div></div></div><p class="muted small">Always check official sources. GOID is an academic prototype.</p>`);
};
const goidOriginalSettings=renderSettings;
renderSettings=function(){return goidOriginalSettings().replace('Five criteria; preset weights total 100%. Staff choose documented evidence categories, not numeric ratings.','Internal legacy evidence settings. User rankings now use preference matching, not these settings. Existing assessment records remain preserved.');};
const goidOriginalRoleForm=roleForm;
roleForm=function(id){goidOriginalRoleForm(id);const sel=$('#role-form select[name="role"]');if(sel){for(const o of sel.options){if(o.value==='student')o.textContent='User (regular account)';}}};
const goidOriginalProfile=renderProfile;
renderProfile=function(){return goidOriginalProfile().replace('Assigned access:','Account access:').replace('Student research prototype','Academic research prototype');};
const goidOriginalEvidencePreview=updateEvidencePreview;
updateEvidencePreview=function(){
 const f=$('#record-form'),p=$('#score-preview');if(!f||!p)return;
 let done=0;for(const k of ['benefit','feasibility','relevance','difficulty']){
  const code=f.elements['e_'+k]?.value,link=f.elements['url_'+k]?.value;
  if(code&&neuLink(link)){done++;}else if(code&&!neuLink(link)){p.textContent='Evidence link missing for '+k+'. Add the supporting official URL or leave this criterion Not Assessed.';return;}
 }
 p.textContent=`${done} of 4 current assessment criteria supported by evidence links. Unassessed criteria are unknown, not zero. Personalized matches are calculated separately from this internal assessment.`;
};
const goidRenderPrevious=render;
render=function(){
 if(state.me?.role==='student'&&(state.surveyActive||!state.preferences)){
  $('#app-view').innerHTML=goidSurveyHTML();
 }else{
  goidRenderPrevious();
 }
 // After routing/rendering, recompute navigation badges (no duplicate UI elements).
 if(state.me)navigation();
};
// Ensure first login runs AFTER goid_features.js is loaded; dashboard boot is
// initialized at DOMContentLoaded in the corresponding patched dashboard.js.

// User-interface actions are delegated so content survives screen re-renders.
document.addEventListener('click',async e=>{
 const el=e.target.closest('[data-goid-action]');if(!el||el.disabled)return;
 const action=el.dataset.goidAction;
 try{
  if(action==='survey-next'){
   if(!goidSaveStep())return;
   if(state.surveyStep<2){state.surveyStep++;render();window.scrollTo(0,0);}else await goidCompleteSurvey();
  }else if(action==='survey-back'){
   state.surveyStep=Math.max(0,state.surveyStep-1);render();window.scrollTo(0,0);
  }else if(action==='survey-cancel'){
   state.surveyActive=false;state.surveyAnswers={};state.page='overview';render();
  }else if(action==='change-survey'){
   state.surveyActive=true;state.surveyAnswers=JSON.parse(JSON.stringify(state.preferences||{}));state.surveyStep=0;render();window.scrollTo(0,0);
  }else if(action==='browse-mode'){
   state.browseMode=el.dataset.mode;render();
  }else if(action==='toggle-filters'){
   state.moreFilters=!state.moreFilters;render();
  }else if(action==='choose-category'){
   state.tab=el.dataset.sector;render();
  }else if(action==='top-toggle'){
   state.showTop20=!state.showTop20;render();
  }else if(action==='filter-category'){
   navigate('explore');state.tab=el.dataset.sector;render();
  }else if(action==='filter-country'){
   navigate('explore');state.country=el.dataset.country;state.moreFilters=true;render();
  }else if(action==='metric'){
   const page=el.dataset.page;if(page==='manage'){navigate(page);return;}
   navigate(page);if(el.dataset.filter==='soon'){state.sort='deadline';render();}
  }
 }catch(err){toast(err.message||String(err),true);}
});

document.addEventListener('change',e=>{
 const field=e.target;
 if(field.matches('#goid-wizard input[data-goid-key]')){
  const q=GOID_Q.find(x=>x.key===field.dataset.goidKey);
  if(q?.exclusive&&field.checked){
   const others=Array.from(document.querySelectorAll('#goid-wizard [name="'+q.key+'"]'));
   for(const c of others)if(c!==field&&(q.exclusive.includes(field.value)||q.exclusive.includes(c.value)))c.checked=false;
  }
  if(q){const selected=Array.from(document.querySelectorAll('#goid-wizard [name="'+q.key+'"]:checked')).map(x=>x.value);state.surveyAnswers[q.key]=q.single?(selected[0]||''):selected;}
 }
 if(field.closest('#record-form')){
  if(field.id==='f-country'||field.id==='f-m_deadline_kind')goidToggleFormFields();
  if(field.name?.startsWith('m_')&&field.type==='checkbox'&&field.checked){
   const boxes=Array.from(field.closest('fieldset')?.querySelectorAll('input[type="checkbox"]')||[]);
   if(['Not Disclosed','None','All'].includes(field.value)){for(const b of boxes)if(b!==field)b.checked=false;}
   else for(const b of boxes)if(['Not Disclosed','None','All'].includes(b.value))b.checked=false;
  }
  if(field.name?.startsWith('e_')||field.name?.startsWith('url_'))updateEvidencePreview();
 }
 if(field.id==='goid-funding'){state.fundingFilter=field.value;goidUpdateExplore();}
 if(field.id==='goid-format'){state.formatFilter=field.value;goidUpdateExplore();}
 if(field.id==='goid-closed'){state.showClosed=field.checked;goidUpdateExplore();}
});
document.addEventListener('input',e=>{
 const el=e.target;if(el.matches('#record-form textarea[maxlength]')){
  const count=el.closest('.form-input')?.querySelector('.goid-count');if(count)count.textContent=el.value.length+' / '+el.maxLength+' characters';
 }
});

// A request counts as read after the user opens My Assistance, not merely on login.
document.addEventListener('click',async e=>{
 const el=e.target.closest('[data-action="nav"][data-page="requests"]');
 if(!el||!state.me||state.me.role!=='student')return;
 const rows=state.requests.filter(r=>r.requester_id===state.me.id);
 if(!rows.length)return;
 try{
  await neuApi('/api/assistance-seen','POST',{ids:rows.map(x=>x.id)});
  const now=new Date().toISOString();state.assistanceReads=rows.map(r=>({request_id:r.id,seen_at:now}));navigation();
 }catch(err){console.warn('Could not mark assistance notifications read:',err.message);}
});

// Make opening from external links / browser resizing predictable.
if(state.pendingEmail)showLogin('verify');
