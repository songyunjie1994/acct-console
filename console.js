"use strict";
const CONFIG = Object.freeze({
  supabaseUrl: "https://mabxdkjqilulkrmqrrgo.supabase.co",
  publishableKey: "sb_publishable_lfHpd1y1gCaQIDXfRkD_8w_O1bPMWGx",
  apiPath: "https://mabxdkjqilulkrmqrrgo.supabase.co/functions/v1/acct-center"
});
const SESSION_KEY = "acct-console-session";
const state = { session: null, data: null, selectedDevice: null, timer: null };

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, kind="info") {
  const n = $("#toast"); if (!n) return;
  n.textContent = msg; n.className = "toast"; n.classList.remove("hidden");
  setTimeout(() => n.classList.add("hidden"), 4500);
}
function loadSession(){ try{return JSON.parse(localStorage.getItem(SESSION_KEY)||"null");}catch{return null;} }
function saveSession(v){ try{ if(v) localStorage.setItem(SESSION_KEY,JSON.stringify(v)); else localStorage.removeItem(SESSION_KEY);}catch{} }
function show(id, on){ $(id).classList.toggle("hidden", !on); }

async function signIn(email,password){
  const r = await fetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=password`, { method:"POST", headers: {"Content-Type":"application/json",apikey:CONFIG.publishableKey}, body: JSON.stringify({email,password}) });
  if(!r.ok){ const b=await r.json().catch(()=>({})); throw new Error(b.error_description||b.msg||`登录失败 HTTP ${r.status}`); }
  const b=await r.json();
  return { accessToken:b.access_token, refreshToken:b.refresh_token, email, expiresAt: Date.now()+Number(b.expires_in||3600)*1000 };
}
let refreshing=null;
async function refreshSession(){
  const s=state.session; if(!s?.refreshToken) return null;
  if(refreshing) return refreshing;
  refreshing=(async()=>{
    try{
      const r=await fetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,{method:"POST",headers:{"Content-Type":"application/json",apikey:CONFIG.publishableKey},body:JSON.stringify({refresh_token:s.refreshToken})});
      if(!r.ok) return null;
      const b=await r.json();
      const next={accessToken:b.access_token,refreshToken:b.refresh_token||s.refreshToken,email:s.email||b.user?.email||"",expiresAt:Date.now()+Number(b.expires_in||3600)*1000};
      state.session=next; saveSession(next); return next;
    }catch{return null;}finally{refreshing=null;}
  })();
  return refreshing;
}
async function ensureFresh(){
  const s=state.session; if(!s?.accessToken) return null;
  const exp=Number(s.expiresAt||0);
  if(!exp || Date.now() < exp-120000) return s;
  return (await refreshSession()) || s;
}
async function api(action,payload={}){
  const s=await ensureFresh(); if(!s) throw new Error("还没登录");
  const r=await fetch(CONFIG.apiPath,{method:"POST",headers:{"Content-Type":"application/json",apikey:CONFIG.publishableKey,Authorization:`Bearer ${s.accessToken}`},body:JSON.stringify({action,...payload})});
  const b=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(b.error||b.message||`HTTP ${r.status}`);
  return b;
}

async function login(){
  try{
    $("#loginError").classList.add("hidden");
    const s=await signIn($("#email").value.trim(),$("#password").value);
    state.session=s; saveSession(s); await boot();
  }catch(e){ $("#loginError").textContent=e.message; $("#loginError").classList.remove("hidden"); }
}
async function boot(){
  if(!state.session){ show("#loginView",true); show("#appView",false); return; }
  try{ await load(); show("#loginView",false); show("#appView",true); $("#userEmail").textContent=state.session.email||""; }catch(e){ state.session=null; saveSession(null); show("#loginView",true); show("#appView",false); toast(e.message,"bad"); }
}

async function load(){
  const d=await api("overview"); state.data=d;
  const devices=d.devices||[]; if(!state.selectedDevice && devices.length) state.selectedDevice=devices[0].id;
  renderDevices(devices);
  renderRuns(d.runs||[]);
  renderSnap(d.snapshots||[]);
}

function renderDevices(devs){
  if(!devs.length){ $("#devices").innerHTML="<div class='muted'>暂无设备</div>"; return; }
  $("#devices").innerHTML = devs.map(dev=>{
    const st=dev.status||{};
    const online = dev.last_seen_at ? `最后上报 ${new Date(dev.last_seen_at).toLocaleString()}` : "从未上报";
    return `<div class="card" style="margin:0 0 12px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div>
          <h3>${esc(dev.name||dev.id)}</h3>
          <div class="muted">${esc(dev.id)} · ${esc(online)}</div>
        </div>
        <span class="pill ${st.lastStatus==='success'?'ok':st.lastStatus==='failed'?'bad':'warn'}">${esc(st.lastStatus||"—")}</span>
      </div>
      <div class="kv"><span>自动采集</span><span>${dev.enabled?'开启':'关闭'} · 每 ${dev.interval_hours} 小时</span></div>
      <div class="kv"><span>配置版本</span><span>${dev.config_version} / 已应用 ${dev.applied_version||'—'}</span></div>
      <div class="kv"><span>最近运行</span><span>${esc(st.lastRunAt||'—')} · ${esc(st.lastError||'无错误')}</span></div>
      <div class="grid" style="margin-top:10px">
        <label>开启自动 <select id="en_${esc(dev.id)}"><option value="true" ${dev.enabled?'selected':''}>开</option><option value="false" ${!dev.enabled?'selected':''}>关</option></select></label>
        <label>间隔小时 <input id="iv_${esc(dev.id)}" type="number" min="1" max="168" value="${dev.interval_hours}" /></label>
      </div>
      <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="primary" onclick="saveConfig('${esc(dev.id)}')">保存间隔</button>
        <button class="secondary" onclick="runNow('${esc(dev.id)}')">立即采集</button>
      </div>
    </div>`;
  }).join("");
}

async function saveConfig(id){
  const enabled = $("#en_"+id).value === "true";
  const interval = Number($("#iv_"+id).value||2);
  try{ await api("save_config",{deviceId:id,enabled,intervalHours:interval}); toast("已保存，设备确认后生效"); await load(); }catch(e){ toast(e.message,"bad"); }
}
async function runNow(id){
  try{ const r=await api("run_now",{deviceId:id}); toast(r.pending?"已有命令在队列":"已下发立即采集"); await load(); }catch(e){ toast(e.message,"bad"); }
}

function renderRuns(runs){
  if(!runs.length){ $("#runs").innerHTML="<div class='muted'>暂无运行记录</div>"; return; }
  $("#runs").innerHTML = `<table><thead><tr><th>时间</th><th>状态</th><th>摘要</th></tr></thead><tbody>`+
    runs.slice(0,40).map(r=>`<tr><td>${esc(r.finished_at||'')}</td><td><span class="pill ${r.status==='success'?'ok':r.status==='failed'?'bad':'warn'}">${esc(r.status)}</span></td><td><code>${esc(JSON.stringify(r.summary||{}).slice(0,240))}</code></td></tr>`).join("")+`</tbody></table>`;
}
function renderSnap(snaps){
  if(!snaps.length){ $("#snapshot").innerHTML="<div class='muted'>暂无快照</div>"; return; }
  $("#snapshot").innerHTML = snaps.map(s=>{
    const d=s.data||{}; const stores=d.stores||{};
    const names=Object.keys(stores);
    return `<div class="card" style="margin:0 0 12px">
      <h3>${esc(s.device_id)}</h3>
      <div class="kv"><span>更新时间</span><span>${esc(s.updated_at||'')}</span></div>
      <div class="kv"><span>店铺数</span><span>${names.length}</span></div>
      <details><summary>查看店铺数据</summary><pre>${esc(JSON.stringify(stores,null,2).slice(0,8000))}</pre></details>
    </div>`;
  }).join("");
}

function startPoll(){ if(state.timer) clearInterval(state.timer); state.timer=setInterval(()=>load().catch(e=>toast(e.message,"bad")),20000); }

$("#loginBtn").addEventListener("click",login);
$("#logoutBtn").addEventListener("click",()=>{state.session=null;saveSession(null);show("#appView",false);show("#loginView",true);});
$("#refreshBtn").addEventListener("click",()=>load().catch(e=>toast(e.message,"bad")));

state.session=loadSession();
if(state.session) boot(); else { show("#loginView",true); show("#appView",false); }
window.addEventListener("load",()=>{ if(state.session) boot(); });
startPoll();