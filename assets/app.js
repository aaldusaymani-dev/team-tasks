/* Team Tasks · مهام الفريق
 * Static front end on Supabase (auth + Postgres + realtime).
 * Access rules live in supabase/schema.sql — this file only renders and writes.
 */
(function(){
'use strict';

const CFG=window.TEAM_TASKS_CONFIG||{};
const SB_KEY=CFG.supabaseKey||CFG.supabaseAnonKey||'';
const APP_TITLE=CFG.appTitle||'مهام الفريق';
document.title=APP_TITLE;
document.documentElement.lang='ar';
document.documentElement.dir='rtl';

const $app=document.getElementById('app'), $modal=document.getElementById('modal-root'), $toast=document.getElementById('toast');
const DAY=86400000;
const STATUSES=[
  {k:'waiting',label:'بالانتظار',c:'var(--wait)'},
  {k:'doing',label:'جاري العمل عليه',c:'var(--doing)'},
  {k:'done',label:'منتهي',c:'var(--done)'}
];
const SL=Object.fromEntries(STATUSES.map(s=>[s.k,s.label]));
const nf=new Intl.NumberFormat('ar-SA');
const N=n=>nf.format(n);
const dfShort=new Intl.DateTimeFormat('ar-SA',{calendar:'gregory',day:'numeric',month:'short'});
const dfTime=new Intl.DateTimeFormat('ar-SA',{calendar:'gregory',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'});
const dfLong=new Intl.DateTimeFormat('ar-SA',{calendar:'gregory',weekday:'long',day:'numeric',month:'long',year:'numeric'});
const dfHijri=new Intl.DateTimeFormat('ar-SA',{calendar:'islamic-umalqura',day:'numeric',month:'long',year:'numeric'});

const S={phase:'boot',sb:null,me:null,role:null,authEmail:'',err:null,
  members:[],tasks:{},channel:null,reloadTimer:null,starting:false,
  filter:'all',showAllDone:{},modal:null,thread:{tid:null,comments:[],log:[],loading:false},
  demo:null,demoAs:'manager'};

/* ---------- helpers ---------- */
function h(tag,attrs,...kids){
  const el=document.createElement(tag);
  if(attrs) for(const [k,v] of Object.entries(attrs)){
    if(v==null||v===false) continue;
    if(k==='class') el.className=v;
    else if(k==='text') el.textContent=v;
    else if(k.startsWith('on')) el.addEventListener(k.slice(2),v);
    else el.setAttribute(k,v===true?'':v);
  }
  for(const kid of kids.flat(3)){ if(kid==null||kid===false) continue; el.append(kid.nodeType?kid:document.createTextNode(String(kid))); }
  return el;
}
function ymd(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function todayStr(){return ymd(new Date());}
function parseDay(s){const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);}
function daysUntil(s){const t=new Date();t.setHours(0,0,0,0);return Math.round((parseDay(s)-t)/DAY);}
function fmtDay(s){try{return dfShort.format(parseDay(s));}catch(e){return s;}}
function ms(v){if(v==null||v==='') return null; if(typeof v==='number') return v; const t=Date.parse(v); return isNaN(t)?null:t;}
function iso(v){return v==null?null:new Date(v).toISOString();}
function dayWord(n){if(n===1)return 'يوم واحد';if(n===2)return 'يومين';if(n<=10)return N(n)+' أيام';return N(n)+' يومًا';}
function sinceLabel(ts){if(!ts)return '';const d=Math.floor((Date.now()-ts)/DAY);if(d<=0)return 'اليوم';if(d===1)return 'من أمس';if(d===2)return 'من يومين';return 'من '+dayWord(d);}
function isLate(t){return !!t.due&&t.status!=='done'&&daysUntil(t.due)<0;}
function hasChallenge(t){return !!(t.challenge&&t.challenge.trim())&&!t.challengeResolved;}
function isEscalated(t){return hasChallenge(t)&&!!t.escalated&&t.status!=='done';}
function resolvedUnseen(t){return !!t.challenge&&!!t.challengeResolved&&t.resolvedRole==='manager'&&!t.resolutionAck;}
function dueLabel(t){
  if(!t.due) return null;
  if(t.status==='done') return {text:'التسليم '+fmtDay(t.due),cls:''};
  const n=daysUntil(t.due);
  if(n<0) return {text:'متأخر '+dayWord(-n),cls:'late'};
  if(n===0) return {text:'التسليم اليوم',cls:'soon'};
  if(n===1) return {text:'التسليم غدًا',cls:'soon'};
  return {text:'باقي '+dayWord(n)+' · '+fmtDay(t.due),cls:''};
}
function todayLine(){const d=new Date();return dfLong.format(d)+' · '+dfHijri.format(d);}
function toast(msg){$toast.textContent=msg;$toast.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>{$toast.hidden=true;},3400);}
function errMsg(e){
  const code=e&&e.code, m=(e&&e.message)||'';
  if(code==='42501'||/row-level security/i.test(m)) return 'ما عندك صلاحية لهذا الإجراء.';
  if(/only the manager/i.test(m)) return 'هذا الإجراء للمدير فقط.';
  if(code==='23505') return 'هذا الإيميل مضاف من قبل.';
  if(code==='23503') return 'ما ينحذف لأن عليه مهام. احذف مهامه أو انقلها لموظف ثاني أول.';
  if(code==='23514') return 'فيه حقل أطول من المسموح أو قيمة غير صحيحة.';
  if(/fetch|network|Failed to/i.test(m)) return 'تعذّر الاتصال. تأكد من الإنترنت وحاول مرة ثانية.';
  if(/JWT|session/i.test(m)) return 'انتهت الجلسة. سجّل دخول مرة ثانية.';
  return 'تعذّر الحفظ. حاول مرة ثانية.';
}

/* ---------- row mapping ---------- */
function fromRow(r){
  return {id:r.id,memberId:r.member_id,title:r.title,details:r.details||'',source:r.source,
    assignedOn:r.assigned_on||'',due:r.due||'',priority:r.priority,status:r.status,
    challenge:r.challenge||'',challengeAt:ms(r.challenge_at),challengeResolved:!!r.challenge_resolved,
    escalated:!!r.escalated,escalatedAt:ms(r.escalated_at),resolvedRole:r.resolved_role,resolvedAt:ms(r.resolved_at),
    resolution:r.resolution||'',resolutionAck:r.resolution_ack!==false,doneAt:ms(r.done_at),
    commentCount:r.comment_count||0,lastCommentRole:r.last_comment_role||null,
    createdRole:r.created_role,createdAt:ms(r.created_at),updatedAt:ms(r.updated_at)};
}
function toRow(o){
  return {title:o.title,details:o.details||'',source:o.source||'manager',assigned_on:o.assignedOn||todayStr(),
    due:o.due||null,priority:o.priority||'normal',status:o.status||'waiting',
    challenge:o.challenge||'',challenge_at:iso(o.challengeAt),challenge_resolved:!!o.challengeResolved,
    escalated:!!o.escalated,escalated_at:iso(o.escalatedAt),resolved_role:o.resolvedRole||null,resolved_at:iso(o.resolvedAt),
    resolution:o.resolution||'',resolution_ack:o.resolutionAck!==false,done_at:iso(o.doneAt)};
}

/* ---------- view model ---------- */
function V(){
  if(S.demo){
    const emps=S.demo.members.filter(m=>m.role==='employee');
    const names=Object.fromEntries(S.demo.members.map(m=>[m.id,m.name]));
    if(S.demoAs==='manager') return {staff:emps.map(m=>m.id),tasks:S.demo.tasks,names,role:'manager',me:'mgr',myName:names.mgr};
    return {staff:[S.demoAs],tasks:{[S.demoAs]:S.demo.tasks[S.demoAs]||{}},names,role:'employee',me:S.demoAs,myName:names[S.demoAs]};
  }
  const names=Object.fromEntries(S.members.map(m=>[m.id,m.name]));
  if(S.role==='employee') return {staff:[S.me.id],tasks:{[S.me.id]:S.tasks[S.me.id]||{}},names,role:'employee',me:S.me.id,myName:S.me.name};
  const emps=S.members.filter(m=>m.role==='employee'&&m.active);
  return {staff:emps.map(m=>m.id),tasks:S.tasks,names,role:'manager',me:S.me.id,myName:S.me.name};
}
function memberById(id){return (S.demo?S.demo.members:S.members).find(m=>m.id===id);}
function nameOf(v,uid){return v.names[uid]||'موظف';}
function getTask(uid,tid){const v=V();return v.tasks[uid]&&v.tasks[uid][tid]||null;}
function allTasks(v,only){
  const out=[];
  for(const uid of (only?[only]:v.staff)){const m=v.tasks[uid]||{};for(const tid in m) out.push({uid,tid,t:m[tid]});}
  return out;
}
function avatar(v,uid,small){
  return h('span',{class:'av'+(small?' sm':''),'aria-hidden':'true'},nameOf(v,uid).trim().charAt(0));
}

/* ---------- data access ---------- */
const api={
  async saveTask(memberId,tid,obj,logTexts){
    const v=V(), now=Date.now();
    if(S.demo){
      const id=tid||('t'+Math.random().toString(36).slice(2,10));
      const prev=(S.demo.tasks[memberId]||{})[id]||{commentCount:0,lastCommentRole:null,createdRole:v.role,createdAt:now};
      (S.demo.tasks[memberId]||(S.demo.tasks[memberId]={}))[id]=Object.assign({},prev,obj,{id,memberId,updatedAt:now});
      const th=S.demo.threads[id]||(S.demo.threads[id]={comments:[],log:[]});
      logTexts.forEach(text=>th.log.push({actor_id:v.me,role:v.role,text,created_at:now}));
      afterLocalChange(id); return id;
    }
    let id=tid;
    if(tid){
      const {error}=await S.sb.from('tasks').update(toRow(obj)).eq('id',tid);
      if(error) throw error;
    }else{
      const {data,error}=await S.sb.from('tasks').insert(Object.assign(toRow(obj),{member_id:memberId})).select('id').single();
      if(error) throw error; id=data.id;
    }
    const prev=(S.tasks[memberId]||{})[id]||{commentCount:0,lastCommentRole:null,createdRole:v.role,createdAt:now};
    (S.tasks[memberId]||(S.tasks[memberId]={}))[id]=Object.assign({},prev,obj,{id,memberId,updatedAt:now});
    if(logTexts.length){
      const {error}=await S.sb.from('task_log').insert(logTexts.map(text=>({task_id:id,actor_id:S.me.id,role:S.role,text:text.slice(0,600)})));
      if(error) console.warn('log',error);
    }
    afterLocalChange(id); scheduleReload(); return id;
  },
  async deleteTask(memberId,tid){
    if(S.demo){delete S.demo.tasks[memberId][tid];afterLocalChange();return;}
    const {error}=await S.sb.from('tasks').delete().eq('id',tid);
    if(error) throw error;
    if(S.tasks[memberId]) delete S.tasks[memberId][tid];
    afterLocalChange(); scheduleReload();
  },
  async addComment(memberId,tid,body){
    const v=V(), now=Date.now();
    if(S.demo){
      const th=S.demo.threads[tid]||(S.demo.threads[tid]={comments:[],log:[]});
      th.comments.push({author_id:v.me,role:v.role,body,created_at:now});
      const t=S.demo.tasks[memberId][tid]; t.commentCount=(t.commentCount||0)+1; t.lastCommentRole=v.role;
      afterLocalChange(tid); return;
    }
    const {error}=await S.sb.from('comments').insert({task_id:tid,author_id:S.me.id,role:S.role,body});
    if(error) throw error;
    await loadThread(tid); scheduleReload();
  },
  async saveRoster(rows,removed){
    if(S.demo){toast('هذا مثال، الأسماء ما تنحفظ.');return;}
    for(const id of removed){
      const {error}=await S.sb.from('members').delete().eq('id',id);
      if(error){ const m=S.members.find(x=>x.id===id); throw Object.assign(error,{who:m&&m.name}); }
    }
    for(let i=0;i<rows.length;i++){
      const r=rows[i], body={name:r.name,email:r.email,sort_order:i+1};
      const q=r.id?S.sb.from('members').update(body).eq('id',r.id):S.sb.from('members').insert(Object.assign(body,{role:'employee'}));
      const {error}=await q; if(error) throw Object.assign(error,{who:r.name});
    }
    await reload();
  }
};
function afterLocalChange(tid){render(); if(S.modal&&S.modal.mode==='edit'&&(!tid||tid===S.modal.tid)) refreshModalLive();}

async function loadThread(tid){
  if(S.demo){const th=S.demo.threads[tid]||{comments:[],log:[]};S.thread={tid,comments:th.comments,log:th.log,loading:false};refreshModalLive();return;}
  if(S.thread.tid!==tid) S.thread={tid,comments:[],log:[],loading:true};
  refreshModalLive();
  const [c,l]=await Promise.all([
    S.sb.from('comments').select('*').eq('task_id',tid).order('created_at').limit(500),
    S.sb.from('task_log').select('*').eq('task_id',tid).order('created_at').limit(500)]);
  if(S.thread.tid!==tid) return;
  S.thread={tid,comments:c.data||[],log:l.data||[],loading:false};
  refreshModalLive();
}

async function reload(){
  const since=new Date(Date.now()-120*DAY).toISOString();
  const [m,t]=await Promise.all([
    S.sb.from('members').select('*').order('sort_order').order('created_at'),
    S.sb.from('tasks').select('*').or('status.neq.done,done_at.gte."'+since+'"').order('created_at').limit(3000)]);
  if(m.error) throw m.error; if(t.error) throw t.error;
  S.members=m.data||[];
  const me=S.members.find(x=>x.id===S.me.id); if(me){S.me=me;S.role=me.role;}
  const map={}; for(const r of (t.data||[])){(map[r.member_id]||(map[r.member_id]={}))[r.id]=fromRow(r);}
  S.tasks=map;
  render();
  if(S.modal&&S.modal.mode==='edit') refreshModalLive();
}
function scheduleReload(){clearTimeout(S.reloadTimer);S.reloadTimer=setTimeout(()=>{reload().catch(e=>console.warn(e));},350);}
function subscribe(){
  if(S.channel) return;
  const onThread=p=>{const row=p.new&&p.new.task_id?p.new:p.old; if(S.modal&&S.modal.mode==='edit'&&row&&row.task_id===S.modal.tid) loadThread(S.modal.tid);};
  S.channel=S.sb.channel('team-tasks')
    .on('postgres_changes',{event:'*',schema:'public',table:'tasks'},scheduleReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'members'},scheduleReload)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'comments'},onThread)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'task_log'},onThread)
    .subscribe();
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&S.phase==='ready') scheduleReload();});
}

/* ---------- task actions ---------- */
function run(p,okMsg){return p.then(r=>{if(okMsg) toast(okMsg);return r;}).catch(e=>{console.warn(e);toast(errMsg(e));throw e;});}
function quickMove(x,to){
  const now=Date.now();
  const obj=Object.assign({},x.t,{status:to,doneAt:to==='done'?now:null});
  run(api.saveTask(x.uid,x.tid,obj,['غيّر الحالة من "'+SL[x.t.status]+'" إلى "'+SL[to]+'"']),
    to==='done'?'أحسنت، انتقلت المهمة إلى منتهي':'انتقلت المهمة إلى '+SL[to]).catch(()=>{});
}
function escalate(uid,tid){
  const cur=getTask(uid,tid); if(!cur) return;
  run(api.saveTask(uid,tid,Object.assign({},cur,{escalated:true,escalatedAt:Date.now()}),['أرسل التحدي للمدير']),'انرسل التحدي لمديرك').catch(()=>{});
}
function resolveByManager(uid,tid,note){
  const cur=getTask(uid,tid); if(!cur) return Promise.resolve();
  return run(api.saveTask(uid,tid,Object.assign({},cur,{challengeResolved:true,resolvedRole:'manager',resolvedAt:Date.now(),resolution:note||'',resolutionAck:false}),
    ['حلّ التحدي'+(note?': '+note:'')]));
}
function ackResolution(uid,tid){
  const cur=getTask(uid,tid); if(!cur) return;
  run(api.saveTask(uid,tid,Object.assign({},cur,{resolutionAck:true}),[])).catch(()=>{});
}
async function signIn(){
  const q={prompt:'select_account'}; if(CFG.googleHostedDomain) q.hd=CFG.googleHostedDomain;
  const {error}=await S.sb.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.origin+location.pathname,queryParams:q}});
  if(error) toast('تعذّر فتح تسجيل الدخول. حاول مرة ثانية.');
}
function signOut(){ if(S.sb) S.sb.auth.signOut(); }

/* ---------- render ---------- */
function render(){
  let body;
  if(S.demo){const v=V();body=v.role==='manager'?managerView(v):employeeView(v);}
  else if(S.phase==='ready'){const v=V();body=v.role==='manager'?managerView(v):employeeView(v);}
  else body=gateView();
  $app.replaceChildren(h('div',{class:'wrap'},body));
}
function header(title,sub,action){
  const acct=(!S.demo&&S.phase==='ready')?h('p',{class:'acct-bar'},(S.me&&S.me.name)+' · ',h('button',{class:'linkish',type:'button',onclick:signOut},'تسجيل الخروج')):null;
  return h('header',{class:'top'},
    h('div',{class:'titles'},h('h1',null,title),h('p',{class:'date'},[sub,todayLine()].filter(Boolean).join(' · ')),acct),
    action||null);
}
function gateView(){
  const demoBtn=h('button',{class:'btn',type:'button',onclick:startDemo},'شاهد مثال تجريبي');
  if(S.phase==='boot'||S.phase==='loading') return [header(APP_TITLE),h('p',{class:'notice'},'جاري التحميل…')];
  if(S.phase==='setup') return [header(APP_TITLE),h('section',{class:'onboard'},
    h('h2',null,'التطبيق يحتاج إعداد'),
    h('p',null,'عبّ رابط مشروع Supabase والمفتاح العام (publishable) في ملف config.js. الخطوات كاملة في ملف README.'),
    h('div',{class:'actions'},demoBtn))];
  if(S.phase==='signedout') return [h('section',{class:'login'},
    h('h1',null,APP_TITLE),
    h('p',{class:'muted'},'سجّل دخولك بحساب Google حق الشركة عشان تشوف مهامك.'),
    S.authErr?h('div',{class:'notice',style:'border-color:var(--late);color:var(--ink)'},
      h('b',null,'ما تم تسجيل الدخول. '),'الرسالة من النظام: ',h('bdi',{dir:'ltr',class:'mail'},S.authErr)):null,
    h('div',{class:'actions'},h('button',{class:'btn primary',type:'button',onclick:signIn},'الدخول بحساب Google'),demoBtn),
    h('p',{class:'date'},todayLine()))];
  if(S.phase==='notmember') return [h('section',{class:'login'},
    h('h1',null,APP_TITLE),
    h('p',null,'حسابك ',h('bdi',{class:'mail'},S.authEmail),' مو مضاف للفريق.'),
    h('p',{class:'muted'},'اطلب من مديرك يضيف إيميلك من "أسماء الفريق"، وبعدها حدّث الصفحة.'),
    h('div',{class:'actions'},h('button',{class:'btn',type:'button',onclick:()=>location.reload()},'تحديث'),h('button',{class:'btn',type:'button',onclick:signOut},'الدخول بحساب ثاني')))];
  return [header(APP_TITLE),h('section',{class:'onboard'},
    h('h2',null,'صار خطأ أثناء التحميل'),
    h('p',{class:'muted'},errMsg(S.err)),
    h('div',{class:'actions'},h('button',{class:'btn primary',type:'button',onclick:()=>location.reload()},'إعادة المحاولة'),h('button',{class:'btn',type:'button',onclick:signOut},'تسجيل الخروج')))];
}
function demoBanner(){
  const seg=h('div',{class:'seg',role:'radiogroup','aria-label':'نوع الشاشة'},
    h('input',{type:'radio',name:'demo-as',id:'demo-as-mgr',checked:S.demoAs==='manager',onchange:()=>{S.demoAs='manager';render();}}),
    h('label',{for:'demo-as-mgr'},'شاشة المدير'),
    h('input',{type:'radio',name:'demo-as',id:'demo-as-emp',checked:S.demoAs!=='manager',onchange:()=>{S.demoAs='e1';render();}}),
    h('label',{for:'demo-as-emp'},'شاشة موظف'));
  return h('div',{class:'banner'},
    h('span',null,'مثال توضيحي ببيانات وهمية. أي تعديل هنا ما ينحفظ.'),
    h('div',{style:'display:flex;gap:10px;flex-wrap:wrap;align-items:center'},seg,
      h('button',{class:'btn small',type:'button',onclick:()=>{S.demo=null;S.demoAs='manager';S.filter='all';closeModal();render();}},'خروج من المثال')));
}

/* ----- manager ----- */
function managerView(v){
  const out=[header(APP_TITLE,null,v.staff.length?h('button',{class:'btn primary',type:'button',onclick:()=>openNew()},'+ مهمة جديدة'):null)];
  if(S.demo) out.push(demoBanner());
  if(!v.staff.length){out.push(onboarding());return out;}
  if(!S.demo){
    const waiting=v.staff.map(memberById).filter(m=>m&&!m.last_seen_at);
    if(waiting.length) out.push(h('div',{class:'notice'},
      h('b',{style:'color:var(--ink)'},'ما دخلوا بعد: '+waiting.map(m=>m.name).join('، ')+'. '),
      'أرسل لهم رابط التطبيق، ويدخلون بحساب Google على نفس الإيميل اللي أضفته. المهام اللي تضيفها لهم الحين بتكون بانتظارهم.'));
  }
  out.push(attentionSection(v),teamSection(v),boardSection(v,true));
  return out;
}
function onboarding(){
  return h('section',{class:'onboard'},
    h('h2',null,'التطبيق جاهز، باقي تضيف فريقك'),
    h('ol',null,
      h('li',null,'من زر "أسماء الفريق" أضف اسم كل موظف وإيميله في الشركة.'),
      h('li',null,'أرسل لهم رابط التطبيق، ويدخل كل واحد بحساب Google على نفس الإيميل.'),
      h('li',null,'كل موظف يشوف مهامه بس، وأنت تتابع الكل من هنا.')),
    h('div',{class:'actions'},
      h('button',{class:'btn primary',type:'button',onclick:openRoster},'أسماء الفريق'),
      S.demo?null:h('button',{class:'btn',type:'button',onclick:startDemo},'شاهد مثال تجريبي')));
}
function attentionSection(v){
  const all=allTasks(v);
  const ch=all.filter(x=>isEscalated(x.t)).sort((a,b)=>(a.t.escalatedAt||0)-(b.t.escalatedAt||0));
  const late=all.filter(x=>isLate(x.t)&&!isEscalated(x.t)).sort((a,b)=>a.t.due.localeCompare(b.t.due));
  const total=ch.length+late.length;
  const sec=h('section',{class:'attention'+(total?'':' calm'),'aria-labelledby':'att-h'},
    h('div',{class:'sec-head'},h('h2',{id:'att-h'},'يحتاج تدخلك'),total?h('span',{class:'muted num'},N(total)+' '+(total===1?'مهمة':total===2?'مهمتين':'مهام')):null));
  if(!total){sec.append(h('p',null,'ما فيه تحديات مرسلة لك ولا مهام متأخرة.'));return sec;}
  if(ch.length) sec.append(h('div',{class:'att-group'},h('div',{class:'att-label'},'تحديات أرسلها لك الموظفون'),ch.map(x=>attItem(v,x,'ch'))));
  if(late.length) sec.append(h('div',{class:'att-group'},h('div',{class:'att-label'},'مهام متأخرة'),late.map(x=>attItem(v,x,'late'))));
  return sec;
}
function attItem(v,x,kind){
  return h('button',{class:'att-item',type:'button',onclick:()=>openEdit(x.uid,x.tid)},
    avatar(v,x.uid),
    h('span',{class:'att-body'},
      h('span',null,h('span',{class:'att-who'},nameOf(v,x.uid)+' · '),h('span',{class:'att-title'},x.t.title)),
      h('span',{class:'att-sub'},kind==='ch'?x.t.challenge:SL[x.t.status]+' · التسليم '+fmtDay(x.t.due))),
    h('span',{class:'att-age'+(kind==='late'?' late':'')},kind==='ch'?sinceLabel(x.t.escalatedAt||x.t.challengeAt):dueLabel(x.t).text));
}
function teamSection(v){
  const weekAgo=Date.now()-7*DAY;
  const rows=v.staff.map(uid=>{
    const ts=allTasks(v,uid).map(x=>x.t);
    const c={w:ts.filter(t=>t.status==='waiting').length,d:ts.filter(t=>t.status==='doing').length,
      late:ts.filter(isLate).length,ch:ts.filter(isEscalated).length,
      wk:ts.filter(t=>t.status==='done'&&(t.doneAt||0)>=weekAgo).length};
    const cell=(n,cls)=>h('td',{class:'n'+(n?(cls?' '+cls:''):' zero')},N(n));
    const m=memberById(uid);
    const seen=S.demo?null:(m&&m.last_seen_at?'آخر دخول '+dfShort.format(new Date(m.last_seen_at)):'لم يدخل بعد');
    return h('tr',{onclick:()=>{S.filter=uid;render();const b=document.getElementById('board');if(b)b.scrollIntoView({behavior:'smooth',block:'start'});}},
      h('td',null,h('span',{class:'who'},avatar(v,uid),h('span',{class:'who-name'},nameOf(v,uid),seen?h('span',{class:'acct'},seen):null))),
      cell(c.w),cell(c.d),cell(c.late,'bad'),cell(c.ch,'warn'),cell(c.wk));
  });
  return h('section',{'aria-labelledby':'team-h'},
    h('div',{class:'sec-head'},h('h2',{id:'team-h'},'الفريق'),
      h('div',{style:'display:flex;gap:12px;align-items:center;flex-wrap:wrap'},
        h('span',{class:'muted',style:'font-size:.85rem'},'اضغط على أي موظف لعرض مهامه'),
        h('button',{class:'btn small',type:'button',onclick:openRoster},'أسماء الفريق'))),
    h('div',{class:'scroll-x'},h('table',null,
      h('thead',null,h('tr',null,h('th',null,'الموظف'),h('th',null,'بالانتظار'),h('th',null,'جاري العمل'),h('th',null,'متأخرة'),h('th',null,'تحديات مرسلة لك'),h('th',null,'أُنجز آخر ٧ أيام'))),
      h('tbody',null,rows))));
}
function boardSection(v,isMgr){
  if(isMgr&&S.filter!=='all'&&!v.staff.includes(S.filter)) S.filter='all';
  const only=isMgr?(S.filter==='all'?null:S.filter):v.me;
  const items=allTasks(v,only);
  const sec=h('section',{id:'board','aria-labelledby':'board-h'});
  const head=h('div',{class:'sec-head'},h('h2',{id:'board-h'},isMgr?'لوحة المهام':'مهامي حسب المرحلة'));
  if(isMgr){
    const tab=(key,label,extra)=>h('button',{class:'tab',type:'button','aria-pressed':String(S.filter===key),onclick:()=>{S.filter=key;render();}},extra||null,label);
    head.append(h('div',{class:'tabs'},tab('all','الكل'),v.staff.map(uid=>tab(uid,nameOf(v,uid),avatar(v,uid,true)))));
  }
  sec.append(head);
  const showEmp=isMgr&&S.filter==='all';
  sec.append(h('div',{class:'board'},STATUSES.map(s=>lane(v,s,items.filter(x=>x.t.status===s.k),showEmp,isMgr))));
  return sec;
}
function lane(v,s,items,showEmp,isMgr){
  if(s.k==='done') items.sort((a,b)=>(b.t.doneAt||0)-(a.t.doneAt||0));
  else items.sort((a,b)=>{
    const pa=a.t.priority==='urgent'?0:1,pb=b.t.priority==='urgent'?0:1; if(pa!==pb) return pa-pb;
    const ha=hasChallenge(a.t)?0:1,hb=hasChallenge(b.t)?0:1; if(ha!==hb) return ha-hb;
    return (a.t.due||'9999').localeCompare(b.t.due||'9999')||(a.t.createdAt||0)-(b.t.createdAt||0);
  });
  const key=s.k+'|'+(isMgr?S.filter:'me');
  let shown=items, hidden=0;
  if(s.k==='done'&&!S.showAllDone[key]&&items.length>6){shown=items.slice(0,6);hidden=items.length-6;}
  const el=h('div',{class:'lane',style:'--c:'+s.c},
    h('div',{class:'lane-head'},h('span',{class:'dot'}),s.label,h('span',{class:'count'},N(items.length))));
  if(!items.length){
    el.append(h('p',{class:'empty-lane'},
      s.k==='waiting'?(isMgr?'ما فيه مهام بالانتظار.':'أي تكليف جديد، حتى لو شفهي، سجّله من زر "مهمة جديدة".'):
      s.k==='doing'?'ما فيه شي قيد العمل الآن.':'المهام المنتهية تظهر هنا.'));
  }
  shown.forEach(x=>el.append(card(v,x,showEmp)));
  if(hidden) el.append(h('button',{class:'more',type:'button',onclick:()=>{S.showAllDone[key]=true;render();}},'عرض '+N(hidden)+' مهام أقدم'));
  return el;
}
function card(v,x,showEmp){
  const t=x.t, d=dueLabel(t), flagged=hasChallenge(t)&&t.status!=='done';
  const cc=t.commentCount||0;
  const top=h('div',{class:'card-top'},
    showEmp?h('span',{class:'chip-emp'},avatar(v,x.uid,true),nameOf(v,x.uid)):null,
    t.priority==='urgent'&&t.status!=='done'?h('span',{class:'pill urgent'},'عاجل'):null);
  const el=h('article',{class:'card'+(flagged?' flagged':'')+(t.status==='done'?' is-done':''),tabindex:'0',role:'button','aria-label':t.title,
      onclick:()=>openEdit(x.uid,x.tid),onkeydown:e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openEdit(x.uid,x.tid);}}},
    top.childNodes.length?top:null,
    h('h3',null,t.title),
    flagged?h('div',{class:'flagbox'},h('b',null,'تحدي: '),t.challenge,
      t.escalated?h('span',{class:'esc'},v.role==='manager'?'أرسله لك '+sinceLabel(t.escalatedAt):'أُرسل للمدير '+sinceLabel(t.escalatedAt)+' · بانتظار الحل'):null):null,
    resolvedUnseen(t)?h('div',{class:'okbox'},h('b',null,'تم حل التحدي'),t.resolution?' · '+t.resolution:''):null,
    h('div',{class:'meta'},
      d?h('span',{class:'due '+d.cls},d.text):null,
      t.source==='self'?h('span',null,'مبادرة'):null,
      cc?h('span',null,N(cc)+' '+(cc===1?'تعليق':cc===2?'تعليقين':'تعليقات')):null,
      cc&&t.lastCommentRole&&t.lastCommentRole!==v.role?h('span',{class:'reply'},t.lastCommentRole==='manager'?'رد المدير':'رد الموظف'):null));
  const next=t.status==='waiting'?['doing','ابدأ العمل']:t.status==='doing'?['done','تم الإنجاز']:null;
  const acts=[];
  if(next) acts.push(h('button',{class:'btn small',type:'button',onclick:e=>{e.stopPropagation();quickMove(x,next[0]);}},next[1]));
  if(flagged&&!t.escalated&&v.role==='employee') acts.push(h('button',{class:'btn small',type:'button',onclick:e=>{e.stopPropagation();escalate(x.uid,x.tid);}},'أرسل التحدي للمدير'));
  if(acts.length) el.append(h('div',{class:'card-actions'},acts));
  return el;
}

/* ----- employee ----- */
function employeeView(v){
  const out=[header('مهامي',v.myName||null,h('button',{class:'btn primary',type:'button',onclick:()=>openNew()},'+ مهمة جديدة'))];
  if(S.demo) out.push(demoBanner());
  const solved=allTasks(v,v.me).filter(x=>resolvedUnseen(x.t)).sort((a,b)=>(b.t.resolvedAt||0)-(a.t.resolvedAt||0));
  if(solved.length) out.push(h('section',{class:'okpanel','aria-labelledby':'ok-h'},
    h('h2',{id:'ok-h'},'تم حل التحدي'),
    solved.map(x=>h('div',{class:'ok-item'},
      h('button',{class:'open',type:'button',onclick:()=>openEdit(x.uid,x.tid)},
        h('b',null,x.t.title),
        h('span',null,x.t.resolution?'رد المدير: '+x.t.resolution:'المدير علّم التحدي محلول.')),
      h('button',{class:'btn small',type:'button',onclick:()=>ackResolution(x.uid,x.tid)},'تمام')))));
  const ts=allTasks(v,v.me).map(x=>x.t);
  const st=(label,n,cls)=>h('div',{class:'stat'+(n&&cls?' '+cls:'')},h('b',null,N(n)),label);
  out.push(h('div',{class:'strip'},
    st('بالانتظار',ts.filter(t=>t.status==='waiting').length),
    st('جاري العمل',ts.filter(t=>t.status==='doing').length),
    st('منتهي',ts.filter(t=>t.status==='done').length),
    st('متأخرة',ts.filter(isLate).length,'bad'),
    st('تحديات مفتوحة',ts.filter(t=>hasChallenge(t)&&t.status!=='done').length,'warn')));
  out.push(boardSection(v,false));
  return out;
}

/* ---------- modals ---------- */
function openNew(){S.modal={mode:'new'};renderModal();}
function openEdit(uid,tid){S.modal={mode:'edit',uid,tid};if(S.thread.tid!==tid) S.thread={tid,comments:[],log:[],loading:true};renderModal();loadThread(tid).catch(()=>{});}
function openRoster(){S.modal={mode:'roster'};renderModal();}
function closeModal(){S.modal=null;$modal.replaceChildren();}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&S.modal) closeModal();});

function seg(name,options,value){
  return h('div',{class:'seg',role:'radiogroup'},options.flatMap(([val,label])=>[
    h('input',{type:'radio',name,id:name+'-'+val,value:val,checked:val===value}),
    h('label',{for:name+'-'+val},label)]));
}
function segVal(form,name){const el=form.querySelector('input[name="'+name+'"]:checked');return el?el.value:null;}
function mountSheet(sheet,focusSel){
  const overlay=h('div',{class:'overlay',onclick:e=>{if(e.target===overlay) closeModal();}},sheet);
  $modal.replaceChildren(overlay);
  const f=focusSel&&sheet.querySelector(focusSel); (f||sheet.querySelector('.x')).focus();
}

function rosterModal(){
  const list=h('div',{style:'display:flex;flex-direction:column;gap:8px'});
  const emps=(S.demo?S.demo.members:S.members).filter(m=>m.role==='employee');
  const v=V();
  const addRow=m=>{
    const key=m&&m.id||('n'+Math.random().toString(36).slice(2,9));
    const hasTasks=m&&Object.keys(v.tasks[m.id]||{}).length>0;
    const row=h('div',{class:'roster-row','data-id':m&&m.id||''},
      h('input',{type:'text',id:'rn-'+key,class:'r-name',value:m?m.name:'',maxlength:'80',placeholder:'اسم الموظف','aria-label':'الاسم'}),
      h('input',{type:'email',id:'re-'+key,class:'r-email',value:m?m.email:'',dir:'ltr',placeholder:'name@company.com','aria-label':'الإيميل'}),
      hasTasks?h('span',{class:'acct',style:'white-space:nowrap'},'عليه مهام'):
        h('button',{class:'btn small danger',type:'button',onclick:()=>row.remove()},'حذف'));
    list.append(row); return row;
  };
  emps.forEach(addRow); if(!emps.length) addRow(null);
  const errEl=h('p',{class:'err',hidden:true});
  const save=h('button',{class:'btn primary',type:'button',onclick:async()=>{
    errEl.hidden=true;
    const rows=[...list.querySelectorAll('.roster-row')].map(r=>({id:r.dataset.id||null,name:r.querySelector('.r-name').value.trim(),email:r.querySelector('.r-email').value.trim().toLowerCase()}))
      .filter(r=>r.name||r.email);
    const bad=rows.find(r=>!r.name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
    if(bad){errEl.textContent='تأكد إن كل سطر فيه اسم وإيميل صحيح'+(bad.name?' ('+bad.name+')':'')+'.';errEl.hidden=false;return;}
    const seen=new Set(); for(const r of rows){if(seen.has(r.email)){errEl.textContent='الإيميل '+r.email+' مكرر.';errEl.hidden=false;return;}seen.add(r.email);}
    const keep=new Set(rows.map(r=>r.id).filter(Boolean));
    const removed=emps.map(m=>m.id).filter(id=>!keep.has(id));
    save.disabled=true;
    try{await api.saveRoster(rows,removed);closeModal();toast('انحفظت الأسماء');}
    catch(e){errEl.textContent=(e.who?e.who+': ':'')+errMsg(e);errEl.hidden=false;save.disabled=false;}
  }},'حفظ');
  const sheet=h('div',{class:'sheet',role:'dialog','aria-modal':'true','aria-labelledby':'r-h'},
    h('div',{class:'sheet-head'},
      h('div',null,h('h2',{id:'r-h'},'أسماء الفريق'),h('p',{class:'src'},'كل موظف يدخل بحساب Google على نفس الإيميل المكتوب هنا.')),
      h('button',{class:'x',type:'button','aria-label':'إغلاق',onclick:closeModal},'×')),
    list,
    h('div',null,h('button',{class:'btn small',type:'button',onclick:()=>addRow(null).querySelector('input').focus()},'+ إضافة موظف')),
    errEl,
    h('div',{class:'form-actions'},save,h('button',{class:'btn',type:'button',onclick:closeModal},'إلغاء')));
  mountSheet(sheet,'input');
}

function renderModal(){
  const m=S.modal; if(!m){$modal.replaceChildren();return;}
  if(m.mode==='roster') return rosterModal();
  const v=V(), isMgr=v.role==='manager';
  const t=m.mode==='edit'?getTask(m.uid,m.tid):null;
  if(m.mode==='edit'&&!t){closeModal();return;}
  const errEl=h('p',{class:'err',hidden:true});

  const empField=(isMgr&&m.mode==='new')?h('label',{class:'field',for:'f-emp'},'الموظف',
    h('select',{id:'f-emp',required:true},h('option',{value:''},'اختر الموظف'),
      v.staff.map(uid=>h('option',{value:uid,selected:S.filter===uid},nameOf(v,uid))))):null;
  const srcField=!isMgr?h('div',{class:'field'},'مصدر المهمة',
    seg('f-src',[['manager','تكليف من المدير'],['self','مبادرة مني']],t?t.source||'manager':'manager')):null;

  const origCh=t?t.challenge||'':'';
  const chText=h('textarea',{id:'f-ch',rows:'3',placeholder:'اكتب التحدي إن وجد: وش اللي موقفك؟ ووش تحتاج من المدير بالضبط؟'},origCh);
  const chRes=h('input',{type:'checkbox',id:'f-chres',checked:!!(t&&t.challengeResolved)});
  const chResRow=h('label',{class:'check',for:'f-chres'},chRes,'تم حل التحدي');
  const chEsc=!isMgr?h('input',{type:'checkbox',id:'f-esc',checked:!!(t&&t.escalated&&!t.challengeResolved)}):null;
  const chEscRow=chEsc?h('label',{class:'check',for:'f-esc'},chEsc,'أرسل التحدي للمدير عشان يحله'):null;
  if(chEsc){
    chEsc.addEventListener('change',()=>{if(chEsc.checked) chRes.checked=false;});
    chRes.addEventListener('change',()=>{if(chRes.checked) chEsc.checked=false;});
  }
  const syncRes=()=>{
    const has=!!chText.value.trim();
    if(t&&t.challengeResolved&&chText.value.trim()!==origCh.trim()&&chRes.dataset.auto!=='1'){chRes.checked=false;chRes.dataset.auto='1';}
    chResRow.hidden=!has||(isMgr&&!!t&&isEscalated(t)); if(chEscRow) chEscRow.hidden=!has;
  };
  chText.addEventListener('input',syncRes); syncRes();
  let chInfo=null;
  if(t&&t.challenge&&t.challengeResolved&&t.resolvedRole==='manager'){
    chInfo=h('div',{class:'resolved-note'},h('b',null,'حلّه المدير'+(t.resolvedAt?' · '+dfShort.format(new Date(t.resolvedAt)):'')),t.resolution||'تم حل التحدي.');
  }else if(t&&isEscalated(t)){
    if(isMgr){
      const note=h('textarea',{id:'f-resolution',rows:'2',placeholder:'اكتب الحل أو التوجيه، ويوصل للموظف مع إشعار "تم حل التحدي"'});
      const btn=h('button',{class:'btn primary small',type:'button',onclick:()=>{
        btn.disabled=true;
        resolveByManager(m.uid,m.tid,note.value.trim()).then(()=>{closeModal();toast('تم حل التحدي، وبيوصل للموظف');}).catch(()=>{btn.disabled=false;});
      }},'تم حل التحدي');
      chInfo=h('div',{class:'resolve'},h('span',{class:'lead'},'أرسله لك '+nameOf(v,m.uid)+' '+sinceLabel(t.escalatedAt)),note,h('div',null,btn));
    }else{
      chInfo=h('p',{style:'font-size:.82rem;color:var(--flag);font-weight:600'},'أُرسل للمدير '+sinceLabel(t.escalatedAt)+' · بانتظار الحل');
    }
  }

  const form=h('form',{novalidate:true},
    empField,
    h('label',{class:'field',for:'f-title'},'عنوان المهمة',h('input',{type:'text',id:'f-title',maxlength:'160',value:t?t.title:'',placeholder:'مثال: تجديد السجل التجاري للفرع'})),
    h('label',{class:'field',for:'f-details'},h('span',null,'التفاصيل ',h('span',{class:'hint'},'(اختياري)')),
      h('textarea',{id:'f-details',rows:'3',maxlength:'4000'},t?t.details||'':'')),
    srcField,
    h('div',{class:'row'},
      h('label',{class:'field',for:'f-assigned'},'تاريخ التكليف',h('input',{type:'date',id:'f-assigned',value:t?t.assignedOn||'':todayStr()})),
      h('label',{class:'field',for:'f-due'},'تاريخ التسليم المتوقع',h('input',{type:'date',id:'f-due',value:t?t.due||'':''}))),
    h('div',{class:'row'},
      h('div',{class:'field'},'الأولوية',seg('f-pri',[['normal','عادي'],['urgent','عاجل']],t?t.priority||'normal':'normal')),
      h('div',{class:'field'},'المرحلة',seg('f-status',STATUSES.map(s=>[s.k,s.label]),t?t.status:'waiting'))),
    h('div',{class:'chbox'},h('label',{class:'field',for:'f-ch'},'التحدي',chText),chInfo,chEscRow,chResRow),
    errEl,
    h('div',{class:'form-actions'},
      h('button',{class:'btn primary',type:'submit'},m.mode==='new'?'إضافة المهمة':'حفظ التعديلات'),
      h('button',{class:'btn',type:'button',onclick:closeModal},'إلغاء'),
      h('span',{class:'spacer'}),
      m.mode==='edit'?deleteButton(m):null));
  form.addEventListener('submit',e=>{e.preventDefault();saveForm(form,m,t,errEl);});

  const srcLine=t?[
    t.source==='self'?'مبادرة من الموظف':'تكليف من المدير',
    isMgr?nameOf(v,m.uid):null,
    t.createdAt?'أُضيفت '+dfShort.format(new Date(t.createdAt)):null].filter(Boolean).join(' · '):(isMgr?'تكليف جديد لأحد الموظفين':'سجّل التكليف عشان يوصل لمديرك');

  const sheet=h('div',{class:'sheet',role:'dialog','aria-modal':'true','aria-labelledby':'m-h'},
    h('div',{class:'sheet-head'},
      h('div',null,h('h2',{id:'m-h'},m.mode==='new'?'مهمة جديدة':'تفاصيل المهمة'),h('p',{class:'src'},srcLine)),
      h('button',{class:'x',type:'button','aria-label':'إغلاق',onclick:closeModal},'×')),
    form,
    m.mode==='edit'?h('div',{id:'m-live',style:'display:flex;flex-direction:column;gap:14px'}):null);
  mountSheet(sheet,m.mode==='new'?(empField?'#f-emp':'#f-title'):null);
  if(m.mode==='edit') refreshModalLive();
}
function deleteButton(m){
  let armed=false;
  const b=h('button',{class:'btn danger',type:'button',onclick:()=>{
    if(!armed){armed=true;b.classList.add('armed');b.textContent='اضغط مرة ثانية للتأكيد';setTimeout(()=>{if(b.isConnected){armed=false;b.classList.remove('armed');b.textContent='حذف المهمة';}},4000);return;}
    run(api.deleteTask(m.uid,m.tid),'انحذفت المهمة').then(closeModal).catch(()=>{});
  }},'حذف المهمة');
  return b;
}
function refreshModalLive(){
  const m=S.modal; if(!m||m.mode!=='edit') return;
  const box=document.getElementById('m-live'); if(!box) return;
  const t=getTask(m.uid,m.tid);
  if(!t){closeModal();toast('انحذفت هذي المهمة');return;}
  const v=V(), th=S.thread.tid===m.tid?S.thread:{comments:[],log:[],loading:true};
  const draft=document.getElementById('f-comment'); const keep=draft?draft.value:'';
  const hadFocus=draft&&document.activeElement===draft;
  const who=(id,role)=>id===v.me?'أنت':(role==='manager'?'المدير':nameOf(v,id));
  const thread=h('div',{class:'thread'},
    th.loading&&!th.comments.length?h('p',{class:'muted',style:'font-size:.88rem'},'جاري تحميل التعليقات…'):
    th.comments.length?th.comments.map(c=>h('div',{class:'comment'+(c.role==='manager'?' mgr':'')},
      h('span',{class:'by'},who(c.author_id,c.role)+' · '+dfTime.format(new Date(ms(c.created_at)))),c.body)):
    h('p',{class:'muted',style:'font-size:.88rem'},'ما فيه تعليقات بعد.'));
  const ta=h('textarea',{id:'f-comment',rows:'2',maxlength:'4000',placeholder:v.role==='manager'?'اكتب توجيهك أو ردك للموظف…':'اكتب تحديثًا أو ردًا لمديرك…'},keep);
  const send=h('button',{class:'btn',type:'button',onclick:()=>{
    const text=ta.value.trim(); if(!text) return;
    send.disabled=true;
    run(api.addComment(m.uid,m.tid,text)).then(()=>{const el=document.getElementById('f-comment');if(el)el.value='';}).catch(()=>{}).finally(()=>{send.disabled=false;});
  }},'إرسال');
  const log=th.log.slice().reverse();
  box.replaceChildren(...[
    h('div',{style:'display:flex;flex-direction:column;gap:10px'},h('h3',{class:'sub-h'},'التعليقات'),thread,h('div',{class:'compose'},ta,send)),
    log.length?h('details',null,h('summary',null,'سجل المهمة ('+N(log.length)+')'),
      h('ul',{class:'log'},log.map(l=>h('li',null,h('time',null,dfTime.format(new Date(ms(l.created_at)))),who(l.actor_id,l.role)+': '+l.text)))):null].filter(Boolean));
  if(hadFocus){const el=document.getElementById('f-comment');if(el){el.focus();el.setSelectionRange(el.value.length,el.value.length);}}
}
function saveForm(form,m,prevTask,errEl){
  const v=V(),isMgr=v.role==='manager';
  const title=form.querySelector('#f-title').value.trim();
  const showErr=msg=>{errEl.textContent=msg;errEl.hidden=false;};
  const target=m.mode==='new'?(isMgr?form.querySelector('#f-emp').value:v.me):m.uid;
  if(!target) return showErr('اختر الموظف أول.');
  if(!title) return showErr('اكتب عنوان المهمة.');
  const now=Date.now(), prev=prevTask||{};
  const challenge=form.querySelector('#f-ch').value.trim();
  const resolved=challenge?form.querySelector('#f-chres').checked:false;
  const escEl=form.querySelector('#f-esc');
  const textChanged=challenge!==(prev.challenge||'').trim();
  const escalated=challenge&&!resolved?(escEl?escEl.checked:!!prev.escalated):(challenge?!!prev.escalated:false);
  const newlyResolved=resolved&&(!prev.challengeResolved||textChanged);
  const status=segVal(form,'f-status')||'waiting';
  const next={
    title,
    details:form.querySelector('#f-details').value.trim(),
    source:isMgr?(prev.source||'manager'):(segVal(form,'f-src')||'manager'),
    assignedOn:form.querySelector('#f-assigned').value||todayStr(),
    due:form.querySelector('#f-due').value||'',
    priority:segVal(form,'f-pri')||'normal',
    status, challenge, challengeResolved:resolved,
    challengeAt:challenge&&!resolved?((prev.challenge&&!prev.challengeResolved&&prev.challengeAt)?prev.challengeAt:now):(challenge?prev.challengeAt||null:null),
    escalated,
    escalatedAt:escalated?((prev.escalated&&!prev.challengeResolved&&prev.escalatedAt)?prev.escalatedAt:now):null,
    resolvedRole:!resolved?null:(newlyResolved?v.role:prev.resolvedRole||v.role),
    resolvedAt:!resolved?null:(newlyResolved?now:prev.resolvedAt||now),
    resolution:!resolved?'':(newlyResolved?(isMgr?((form.querySelector('#f-resolution')||{}).value||'').trim():''):prev.resolution||''),
    resolutionAck:!resolved?true:(newlyResolved?!isMgr:prev.resolutionAck!==false),
    doneAt:status==='done'?(prev.status==='done'&&prev.doneAt?prev.doneAt:now):null
  };
  const L=[];
  if(m.mode==='new'){L.push('أضاف المهمة');if(challenge) L.push('سجّل تحدي');if(escalated) L.push('أرسل التحدي للمدير');}
  else{
    if(escalated&&!(prev.escalated&&!prev.challengeResolved)) L.push('أرسل التحدي للمدير');
    else if(!escalated&&prev.escalated&&!prev.challengeResolved&&challenge&&!resolved) L.push('سحب طلب التحدي من المدير');
    if(prev.status!==status) L.push('غيّر الحالة من "'+SL[prev.status]+'" إلى "'+SL[status]+'"');
    if(!prev.challenge&&challenge) L.push('سجّل تحدي');
    else if(prev.challenge&&!challenge) L.push('مسح التحدي');
    else if(hasChallenge(prev)&&resolved) L.push('علّم التحدي "تم الحل"');
    else if(prev.challengeResolved&&!resolved&&challenge) L.push('أعاد فتح التحدي');
    else if(challenge!==(prev.challenge||'')) L.push('عدّل نص التحدي');
    if((prev.due||'')!==next.due) L.push(next.due?'غيّر تاريخ التسليم إلى '+fmtDay(next.due):'شال تاريخ التسليم');
    if((prev.priority||'normal')!==next.priority) L.push(next.priority==='urgent'?'رفع الأولوية إلى عاجل':'غيّر الأولوية إلى عادي');
    if(prev.title!==title) L.push('عدّل العنوان');
  }
  const btn=form.querySelector('button[type=submit]'); if(btn) btn.disabled=true;
  run(api.saveTask(target,m.mode==='new'?null:m.tid,next,L),m.mode==='new'?'انضافت المهمة':'تم الحفظ')
    .then(closeModal).catch(e=>{if(btn) btn.disabled=false;showErr(errMsg(e));});
}

/* ---------- demo ---------- */
function startDemo(){
  const d=o=>{const x=new Date();x.setDate(x.getDate()+o);return ymd(x);};
  const ago=n=>Date.now()-n*DAY;
  const T=o=>Object.assign({details:'',source:'manager',assignedOn:d(-3),due:'',priority:'normal',status:'waiting',challenge:'',challengeResolved:false,challengeAt:null,escalated:false,escalatedAt:null,resolvedRole:null,resolvedAt:null,resolution:'',resolutionAck:true,doneAt:null,commentCount:0,lastCommentRole:null,createdRole:'manager',createdAt:ago(3),updatedAt:ago(1)},o);
  S.demo={
    members:[{id:'mgr',name:'المدير',role:'manager'},{id:'e1',name:'موظف ١',role:'employee'},{id:'e2',name:'موظف ٢',role:'employee'},{id:'e3',name:'موظف ٣',role:'employee'}],
    tasks:{
      e1:{
        a1:T({title:'تجديد السجل التجاري للفرع الرئيسي',status:'doing',priority:'urgent',due:d(2)}),
        a4:T({title:'تجديد شهادة الدفاع المدني',status:'doing',due:d(3),challenge:'النظام يطلب شهادة إتمام بناء غير موجودة عندنا.',challengeAt:ago(3),escalated:true,escalatedAt:ago(3),
          challengeResolved:true,resolvedRole:'manager',resolvedAt:ago(0.1),resolutionAck:false,resolution:'تواصلت مع المالك وأرسل الشهادة على إيميلك. كمّل الطلب.'}),
        a2:T({title:'استخراج ٣ تأشيرات عمل عبر منصة قوى',status:'doing',due:d(-1),
          challenge:'المنصة تطلب تفويض من المالك على أبشر أعمال. أحتاج تتواصل مع المفوّض يفعّل الصلاحية.',challengeAt:ago(2),escalated:true,escalatedAt:ago(2),commentCount:2,lastCommentRole:'manager'}),
        a3:T({title:'رفع شهادة الزكاة المحدّثة',status:'done',doneAt:ago(1)})
      },
      e2:{
        b1:T({title:'تجديد رخصة البلدية للمستودع',due:d(5),source:'self',createdRole:'employee'}),
        b2:T({title:'تحديث بيانات المنشأة في مقيم',status:'doing',due:d(1),challenge:'رقم الجوال المسجّل للمنشأة قديم، أحاول أحدّثه من أبشر.',challengeAt:ago(1)}),
        b3:T({title:'متابعة اعتراض مخالفة لدى وزارة الموارد البشرية',status:'doing',due:d(-3)})
      },
      e3:{
        c1:T({title:'إصدار شهادة السعودة لملف المنافسة',priority:'urgent',due:d(0)}),
        c2:T({title:'نقل كفالة موظف جديد',status:'doing',due:d(4),challenge:'على العامل بلاغ تغيّب قديم من الكفيل السابق. يحتاج قرار منك: نكمل الإجراء ولا نوقف؟',challengeAt:ago(1),escalated:true,escalatedAt:ago(1)}),
        c3:T({title:'تجديد اشتراك الغرفة التجارية',status:'done',doneAt:ago(4)})
      }
    },
    threads:{a2:{comments:[{author_id:'e1',role:'employee',created_at:ago(2),body:'رفعت الطلب وتوقف عند التفويض.'},{author_id:'mgr',role:'manager',created_at:ago(1),body:'كلمته الصباح، بيفعّلها اليوم إن شاء الله.'}],log:[]}}
  };
  for(const uid in S.demo.tasks) for(const tid in S.demo.tasks[uid]) Object.assign(S.demo.tasks[uid][tid],{id:tid,memberId:uid});
  S.demoAs='manager';S.filter='all';render();window.scrollTo(0,0);
}

/* ---------- boot ---------- */
async function start(session){
  if(S.starting||S.phase==='ready') return; S.starting=true;
  S.authEmail=(session.user&&session.user.email)||'';
  S.phase='loading'; render();
  try{
    const {data,error}=await S.sb.rpc('touch_me');
    if(error) throw error;
    const me=Array.isArray(data)?data[0]:data;
    if(!me){S.phase='notmember';S.starting=false;render();return;}
    S.me=me;S.role=me.role;
    await reload(); subscribe(); S.phase='ready';
  }catch(e){console.warn(e);S.err=e;S.phase='error';}
  S.starting=false; render();
}
async function boot(){
  if(new URLSearchParams(location.search).has('demo')){startDemo();}
  // Supabase sends sign-in failures back as ?error_description=… (or in the #hash)
  const qp=new URLSearchParams(location.search), hp=new URLSearchParams(location.hash.replace(/^#/,''));
  const authErr=qp.get('error_description')||hp.get('error_description')||qp.get('error')||hp.get('error');
  const hadCode=qp.has('code');
  if(authErr){S.authErr=authErr.replace(/\+/g,' ');history.replaceState(null,'',location.pathname);}
  const configured=CFG.supabaseUrl&&SB_KEY&&!/YOUR-/.test(CFG.supabaseUrl+SB_KEY);
  if(!configured||!window.supabase){S.phase='setup';render();return;}
  S.sb=window.supabase.createClient(CFG.supabaseUrl,SB_KEY,{auth:{persistSession:true,detectSessionInUrl:true,flowType:'pkce'}});
  S.sb.auth.onAuthStateChange((ev,session)=>{
    if(ev==='SIGNED_OUT'){S.phase='signedout';S.me=null;S.members=[];S.tasks={};if(S.channel){S.sb.removeChannel(S.channel);S.channel=null;}closeModal();render();}
    else if(session&&(ev==='SIGNED_IN'||ev==='INITIAL_SESSION')) setTimeout(()=>start(session),0);
  });
  // surfaces a failed code exchange (?code=…) that would otherwise just land back on the login screen
  try{const init=await S.sb.auth.initialize(); if(init&&init.error&&!S.authErr) S.authErr=init.error.message||String(init.error);}catch(e){if(!S.authErr) S.authErr=e.message||String(e);}
  const {data}=await S.sb.auth.getSession();
  if(hadCode&&!(data&&data.session)&&!S.authErr) S.authErr='Sign-in code returned but no session was created (PKCE code verifier not found in this browser).';
  if(hadCode) history.replaceState(null,'',location.pathname);
  if(data&&data.session) start(data.session); else if(S.phase==='boot'){S.phase='signedout';render();}
}
render();
boot().catch(e=>{console.warn(e);S.err=e;S.phase='error';render();});
})();
