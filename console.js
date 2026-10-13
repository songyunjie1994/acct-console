"use strict";
/* 账户中心采集台 · 网页端
 * 只负责展示与下发指令；采集在采集机 daemon 上执行。
 * 页面里没有任何密钥，权限全在 Supabase Edge Function。
 */
const CONFIG = Object.freeze({
  supabaseUrl: "https://mabxdkjqilulkrmqrrgo.supabase.co",
  publishableKey: "sb_publishable_lfHpd1y1gCaQIDXfRkD_8w_O1bPMWGx",
  apiPath: "https://mabxdkjqilulkrmqrrgo.supabase.co/functions/v1/acct-center"
});
const SESSION_KEY = "acct-console-session";
const state = { session: null, data: null, timer: null };

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const localTime = (v) => {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
};
const money = (n, symbol = "") => (n == null || n === "" || Number.isNaN(Number(n)) ? "—" : `${symbol}${Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`);
const STATUS_TEXT = { success: "成功", partial: "部分成功", failed: "失败", skipped: "已跳过", running: "运行中", done: "完成", queued: "排队中" };

function toast(message, kind = "info") {
  const node = $("#toast");
  node.textContent = message;
  node.className = "toast";
  if (kind === "bad") node.style.background = "#7f1d1d";
  else if (kind === "ok") node.style.background = "#14532d";
  else node.style.background = "#0f172a";
  setTimeout(() => node.classList.add("hidden"), 4200);
}
function show(id, on) { $(id).classList.toggle("hidden", !on); }

function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; } }
function saveSession(v) { try { if (v) localStorage.setItem(SESSION_KEY, JSON.stringify(v)); else localStorage.removeItem(SESSION_KEY); } catch {} }

async function signIn(email, password) {
  const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: CONFIG.publishableKey },
    body: JSON.stringify({ email, password })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const raw = body.error_description || body.msg || "";
    const message = /invalid login credentials/i.test(raw) ? "邮箱或密码不对"
      : /email not confirmed/i.test(raw) ? "这个邮箱还没确认（需要在 Supabase 里勾 Auto Confirm）"
        : raw || `登录失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  const body = await response.json();
  return { accessToken: body.access_token, refreshToken: body.refresh_token, email, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
}

let refreshing = null;
async function refreshSession() {
  const session = state.session;
  if (!session?.refreshToken) return null;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: CONFIG.publishableKey },
        body: JSON.stringify({ refresh_token: session.refreshToken })
      });
      if (!response.ok) return null;
      const body = await response.json();
      const next = { accessToken: body.access_token, refreshToken: body.refresh_token || session.refreshToken, email: session.email || body.user?.email || "", expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
      state.session = next; saveSession(next); return next;
    } catch { return null; } finally { refreshing = null; }
  })();
  return refreshing;
}
async function ensureFresh() {
  const session = state.session;
  if (!session?.accessToken) return null;
  if (!session.expiresAt || Date.now() < session.expiresAt - 120000) return session;
  return (await refreshSession()) || session;
}

async function api(action, payload = {}) {
  const session = await ensureFresh();
  if (!session) throw new Error("还没登录");
  const response = await fetch(CONFIG.apiPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: CONFIG.publishableKey,
      Authorization: `Bearer ${session.accessToken}`
    },
    body: JSON.stringify({ action, ...payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `请求失败（HTTP ${response.status}）`);
  return body;
}

async function login() {
  try {
    $("#loginError").classList.add("hidden");
    $("#loginBtn").disabled = true;
    const session = await signIn($("#email").value.trim(), $("#password").value);
    state.session = session; saveSession(session);
    await boot();
  } catch (error) {
    $("#loginError").textContent = error.message;
    $("#loginError").classList.remove("hidden");
  } finally { $("#loginBtn").disabled = false; }
}

async function boot() {
  if (!state.session) { show("#loginView", true); show("#appView", false); return; }
  show("#loginView", false); show("#appView", true);
  $("#userEmail").textContent = state.session.email || "";
  await load();
}
async function logout() { state.session = null; saveSession(null); show("#appView", false); show("#loginView", true); }

async function load() {
  const data = await api("overview");
  state.data = data;
  renderMetrics(data);
  renderDevices(data.devices || []);
  renderRuns(data.runs || []);
  renderSnapshots(data.snapshots || []);
}

function latestRun(runs) { return runs && runs.length ? runs[0] : null; }
function renderMetrics(data) {
  const devices = data.devices || [];
  const runs = data.runs || [];
  const snapshots = data.snapshots || [];
  const run = latestRun(runs);
  const stores = snapshots.reduce((sum, row) => sum + Object.keys(row.data?.stores || {}).length, 0);
  $("#mStores").textContent = stores || "—";
  $("#mStatus").innerHTML = run ? `<span class="pill ${run.status === "success" ? "ok" : run.status === "failed" ? "bad" : "warn"}">${esc(STATUS_TEXT[run.status] || run.status)}</span>` : "—";
  $("#mSeen").textContent = devices[0]?.last_seen_at ? localTime(devices[0].last_seen_at) : "—";
  $("#mNext").textContent = devices[0]?.status?.schedule?.nextRunAt ? localTime(devices[0].status.schedule.nextRunAt) : "—";
}

function renderDevices(devices) {
  const box = $("#devices");
  if (!devices.length) { box.innerHTML = `<div class="empty">还没有设备上报。先在采集机上运行 <b>connect-web.cmd</b>，再启动 <b>start-collector.vbs</b>。</div>`; return; }
  box.innerHTML = devices.map((dev) => {
    const status = dev.status || {};
    const schedule = status.schedule || {};
    const lastStatus = status.lastStatus || "—";
    const online = dev.last_seen_at && (Date.now() - new Date(dev.last_seen_at).getTime() < 120000);
    const applied = Number(dev.applied_version || 0) >= Number(dev.config_version || 1);
    return `<div class="device">
      <div class="device-head">
        <div>
          <h3>${esc(dev.name || dev.id)}</h3>
          <div class="device-meta">${esc(dev.id)} · 最后上报 ${esc(localTime(dev.last_seen_at))}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span class="pill ${online ? "live" : "bad"}">${online ? "在线" : "离线"}</span>
          <span class="pill ${lastStatus === "success" ? "ok" : lastStatus === "failed" ? "bad" : "warn"}">${esc(STATUS_TEXT[lastStatus] || lastStatus)}</span>
          <span class="pill ${applied ? "ok" : "warn"}">${applied ? "配置已应用" : "等设备确认"}</span>
        </div>
      </div>
      <div class="device-grid">
        <div class="kv"><span>最近错误</span><span class="${status.lastError ? "bad" : ""}">${esc(status.lastError || "无")}</span></div>
        <div class="kv"><span>最近运行</span><span>${esc(status.lastRunAt || "—")}</span></div>
        <div class="kv"><span>登录态</span><span>${status.sessionPresent ? "已保存" : "未登录"}</span></div>
        <div class="kv"><span>下次自动</span><span>${esc(localTime(schedule.nextRunAt))}</span></div>
      </div>
      <div class="device-controls">
        <label>自动采集<select id="en_${esc(dev.id)}"><option value="true"${dev.enabled ? " selected" : ""}>开</option><option value="false"${dev.enabled ? "" : " selected"}>关</option></select></label>
        <label>间隔小时<input id="iv_${esc(dev.id)}" type="number" min="1" max="168" value="${esc(dev.interval_hours || 2)}" /></label>
        <div class="device-actions">
          <button class="secondary tiny" onclick="saveConfig('${esc(dev.id)}')">保存间隔</button>
          <button class="tiny" onclick="runNow('${esc(dev.id)}')">立即采集</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

async function saveConfig(id) {
  const enabled = ($("#en_" + id)?.value === "true");
  const intervalHours = Math.max(1, Math.min(168, Number($("#iv_" + id)?.value) || 2));
  try { await api("save_config", { deviceId: id, enabled, intervalHours }); toast("配置已保存，等设备心跳确认", "ok"); await load(); }
  catch (error) { toast(error.message, "bad"); }
}
async function runNow(id) {
  try { const result = await api("run_now", { deviceId: id }); toast(result.pending ? "已有一条采集指令在队列里" : "已下发「立即采集」", "ok"); await load(); }
  catch (error) { toast(error.message, "bad"); }
}

function runSummary(run) {
  const summary = run.summary || {};
  if (summary.error) return summary.error;
  if (summary.total != null) return `${summary.ok ?? "?"}/${summary.total} 家成功${summary.failed?.length ? " · 失败：" + summary.failed.slice(0, 4).join("、") : ""}`;
  if (summary.trigger) return `触发：${summary.trigger}`;
  return JSON.stringify(summary).slice(0, 160);
}
function renderRuns(runs) {
  const box = $("#runs");
  if (!runs.length) { box.innerHTML = `<div class="empty">还没有运行记录。等采集机跑一轮，或点上面的「立即采集」。</div>`; return; }
  box.innerHTML = runs.slice(0, 30).map((run) => {
    const cls = run.status === "success" ? "ok" : run.status === "failed" ? "bad" : "warn";
    return `<details class="run">
      <summary class="run-head">
        <span class="run-time">${esc(localTime(run.finished_at))}</span>
        <span class="pill ${cls}">${esc(STATUS_TEXT[run.status] || run.status)}</span>
        <span class="run-summary">${esc(runSummary(run))}</span>
      </summary>
      <pre>${esc(JSON.stringify(run.summary || {}, null, 2))}</pre>
    </details>`;
  }).join("");
}

function storeRow(store) {
  const goodsUsd = store.goods?.usd || {};
  const goodsRmb = store.goods?.rmb || {};
  const inventory = store.inventory || {};
  const collection = store.collection || {};
  const inventoryCount = inventory.count ?? (Array.isArray(inventory.items) ? inventory.items.length : null);
  const rows = [
    ["可提现 USD / RMB", `${money(goodsUsd.withdrawable, "$")} / ${money(goodsRmb.withdrawable, "¥")}`],
    ["冻结款 USD / RMB", `${money(goodsUsd.frozen, "$")} / ${money(goodsRmb.frozen, "¥")}`],
    ["待结算 / 待换汇", `${money(store.pending?.toSettle, "¥")} / ${money(store.pending?.toExchange, "¥")}`],
    ["保证金", money(store.deposit?.baseBalance, "¥")],
    ["库存条数", inventoryCount == null ? "—" : `${inventoryCount}${inventory.truncated ? "（截断）" : ""}`],
    ["供应链欠费", store.supply?.debt ? money(store.supply.debt, "¥") : "无"],
    ["采集状态", collection.status === "stale" ? "旧数据" : "成功"],
    ["采集时间", collection.collectedAt || "—"],
  ];
  return rows.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("");
}
function renderSnapshots(snapshots) {
  const box = $("#snapshot");
  if (!snapshots.length) { box.innerHTML = `<div class="empty">还没有账户快照。采集机上成功跑一轮后会自动同步到这里。</div>`; return; }
  box.innerHTML = snapshots.map((snap) => {
    const stores = snap.data?.stores || {};
    const names = Object.keys(stores);
    const failed = snap.data?.failedStores || [];
    return `<div style="margin-bottom:14px">
      <div class="card-head" style="margin-bottom:8px">
        <h3 style="margin:0;font-size:14px">${esc(snap.device_id)} · ${names.length} 家店铺</h3>
        <span class="muted">快照时间 ${esc(localTime(snap.updated_at))}${failed.length ? ` · 上轮失败 ${failed.length} 家` : ""}</span>
      </div>
      <div class="snap-stores">
        ${names.map((name) => `<div class="store">
          <h4>${esc(name)}</h4>
          ${storeRow(stores[name] || {})}
          <details><summary>查看原始数据</summary><pre>${esc(JSON.stringify(stores[name] || {}, null, 2).slice(0, 6000))}</pre></details>
        </div>`).join("")}
      </div>
    </div>`;
  }).join("");
}

function startPoll() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => load().catch((error) => toast(error.message, "bad")), 20000);
}

$("#loginBtn").addEventListener("click", login);
$("#password").addEventListener("keydown", (event) => { if (event.key === "Enter") login(); });
$("#refreshBtn").addEventListener("click", () => load().then(() => toast("已刷新", "ok")).catch((error) => toast(error.message, "bad")));
$("#logoutBtn").addEventListener("click", logout);

state.session = loadSession();
if (state.session) boot().catch(() => { state.session = null; saveSession(null); show("#loginView", true); });
else { show("#loginView", true); show("#appView", false); }
startPoll();