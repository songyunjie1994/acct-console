"use strict";
/* 账户中心采集台（网页版）
 * 参考 collector-console 的视觉与交互；采集动作在采集机 daemon 上执行。
 * 页面里没有任何密钥，权限全在 Supabase Edge Function。
 */
const CONFIG = Object.freeze({
  supabaseUrl: "https://mabxdkjqilulkrmqrrgo.supabase.co",
  publishableKey: "sb_publishable_lfHpd1y1gCaQIDXfRkD_8w_O1bPMWGx",
  apiPath: "https://mabxdkjqilulkrmqrrgo.supabase.co/functions/v1/acct-center"
});
const SESSION_KEY = "acct-console-session";
const state = { session: null, data: null, selectedDeviceId: null, timer: null, refreshing: false };

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const localTime = (v) => {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const money = (n, symbol = "") => (n == null || n === "" || Number.isNaN(Number(n)) ? "—" : `${symbol}${Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`);
const STATUS_TEXT = { success: "成功", partial: "部分成功", failed: "失败", skipped: "已跳过", queued: "排队中", running: "运行中" };
const statusClass = (status) => (status === "success" || status === "done" ? "on" : status === "failed" ? "off" : "wait");

function toast(message, kind = "info") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast ${kind === "ok" ? "ok" : kind === "bad" ? "error" : kind === "warn" ? "warn" : ""}`;
  node.classList.remove("hidden");
  setTimeout(() => node.classList.add("hidden"), 4200);
}
function show(view) {
  $("#loginView").classList.toggle("hidden", view !== "login");
  $("#mainView").classList.toggle("hidden", view !== "main");
}

/* ---------------- 登录 / 令牌 ---------------- */
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
    headers: { "Content-Type": "application/json", apikey: CONFIG.publishableKey, Authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({ action, ...payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `请求失败（HTTP ${response.status}）`);
  return body;
}

async function login() {
  try {
    $("#loginError").textContent = "";
    $("#loginBtn").disabled = true;
    const session = await signIn($("#email").value.trim(), $("#password").value);
    state.session = session; saveSession(session);
    await boot();
  } catch (error) {
    $("#loginError").textContent = error.message;
  } finally { $("#loginBtn").disabled = false; }
}
async function boot() {
  if (!state.session) { show("login"); return; }
  show("main");
  $("#whoami").textContent = state.session.email || "";
  await load();
}
function logout() { state.session = null; saveSession(null); show("login"); }

async function load() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const data = await api("overview");
    state.data = data;
    const devices = data.devices || [];
    if (!state.selectedDeviceId || !devices.some((d) => d.id === state.selectedDeviceId)) state.selectedDeviceId = devices[0]?.id || null;
    renderDeviceSelect(devices);
    renderOverview(devices, data.runs || [], data.snapshots || []);
    renderDevices(devices);
    renderSnapshots(data.snapshots || []);
    renderActivity(data.runs || []);
  } finally { state.refreshing = false; }
}
function selectedDevice() { return (state.data?.devices || []).find((d) => d.id === state.selectedDeviceId) || null; }

/* ---------------- 顶部与控制条 ---------------- */
function renderDeviceSelect(devices) {
  const select = $("#deviceSelect");
  select.innerHTML = devices.map((d) => `<option value="${esc(d.id)}"${d.id === state.selectedDeviceId ? " selected" : ""}>${esc(d.name || d.id)}</option>`).join("") || `<option value="">没有设备</option>`;
  select.onchange = () => { state.selectedDeviceId = select.value; renderDevices(state.data?.devices || []); };
  const device = selectedDevice();
  const online = device?.last_seen_at && (Date.now() - new Date(device.last_seen_at).getTime() < 120000);
  const badge = $("#deviceOnline");
  badge.className = `inline-status ${online ? "on" : "off"}`;
  badge.querySelector("span").textContent = online ? "在线" : "离线";
}
function renderOverview(devices, runs, snapshots) {
  const device = selectedDevice();
  const stores = snapshots.reduce((sum, row) => sum + Object.keys(row.data?.stores || {}).length, 0);
  const lastRun = runs[0];
  $("#toolCount").textContent = stores || "—";
  $("#failCount").innerHTML = lastRun
    ? `<span class="pill ${statusClass(lastRun.status)}">${esc(STATUS_TEXT[lastRun.status] || lastRun.status)}</span>`
    : "—";
  const running = !!device?.status?.running;
  $("#jobStatus").className = `job-status ${running ? "busy" : lastRun ? "active" : ""}`;
  $("#jobStatusText").textContent = running ? "采集机正在运行" : device?.status?.lastError ? `异常：${device.status.lastError}` : "空闲";
  if (device) {
    $("#autoEnabled").checked = !!device.enabled;
    $("#autoHours").value = device.interval_hours || 2;
    const applied = Number(device.applied_version || 0) >= Number(device.config_version || 1);
    $("#autoStatus").textContent = `${device.enabled ? "已开启" : "未开启"} · 每 ${device.interval_hours || 2} 小时` +
      (applied ? " · 设备已应用" : " · 等待设备确认") +
      (device.status?.schedule?.nextRunAt ? ` · 下次 ${localTime(device.status.schedule.nextRunAt)}` : "");
  } else {
    $("#autoStatus").textContent = "还没有设备上报。先在采集机上运行 connect-web.cmd，再启动 start-collector.vbs。";
  }
  $("#manualRun").disabled = !device;
  $("#saveAuto").disabled = !device;
}

/* ---------------- 设备 ---------------- */
function renderDevices(devices) {
  const box = $("#deviceGrid");
  if (!devices.length) {
    box.innerHTML = `<div class="panel"><div class="empty-state">还没有设备。采集机上运行 <b>connect-web.cmd</b> 后启动 <b>start-collector.vbs</b>，这里就会出现。</div></div>`;
    return;
  }
  box.innerHTML = devices.map((device) => {
    const status = device.status || {};
    const applied = Number(device.applied_version || 0) >= Number(device.config_version || 1);
    const active = device.id === state.selectedDeviceId;
    return `<div class="device-card" style="${active ? "border-color:#7658e8;box-shadow:0 9px 24px rgba(92,62,200,.12)" : ""}">
      <h3>${esc(device.name || device.id)}</h3>
      <div class="device-sub">${esc(device.id)} · 最后上报 ${esc(localTime(device.last_seen_at))}</div>
      <div class="device-rows">
        <div class="device-row"><span>最近运行</span><span>${esc(status.lastRunAt || "—")}</span></div>
        <div class="device-row"><span>最近错误</span><span>${esc(status.lastError || "无")}</span></div>
        <div class="device-row"><span>登录态</span><span>${status.sessionPresent ? "已保存" : "未登录"}</span></div>
        <div class="device-row"><span>配置版本</span><span>${device.config_version} / 已应用 ${device.applied_version || "—"} ${applied ? "✓" : "（等待）"}</span></div>
        <div class="device-row"><span>自动采集</span><span>${device.enabled ? "开" : "关"} · 每 ${device.interval_hours} 小时</span></div>
      </div>
      <div class="device-controls">
        <label>自动<select id="en_${esc(device.id)}"><option value="true"${device.enabled ? " selected" : ""}>开</option><option value="false"${device.enabled ? "" : " selected"}>关</option></select></label>
        <label>间隔<input id="iv_${esc(device.id)}" type="number" min="1" max="168" value="${esc(device.interval_hours || 2)}" /></label>
        <div class="device-actions">
          <button class="ghost-button" onclick="saveDevice('${esc(device.id)}')">保存</button>
          <button class="primary-action small" onclick="runNow('${esc(device.id)}')">立即采集</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

async function saveDevice(id) {
  const enabled = $("#en_" + id)?.value === "true";
  const intervalHours = Math.max(1, Math.min(168, Number($("#iv_" + id)?.value) || 2));
  try {
    await api("save_config", { deviceId: id, enabled, intervalHours });
    toast("已保存，等设备心跳确认", "ok");
    await load();
  } catch (error) { toast(error.message, "bad"); }
}
async function runNow(id) {
  const target = id || state.selectedDeviceId;
  if (!target) return;
  try {
    const result = await api("run_now", { deviceId: target });
    toast(result.pending ? "队列里已有一条指令，等它执行" : "已下发「立即采集」", "ok");
    await load();
  } catch (error) { toast(error.message, "bad"); }
}

/* ---------------- 快照 ---------------- */
function storeRows(store) {
  const goodsUsd = store.goods?.usd || {};
  const goodsRmb = store.goods?.rmb || {};
  const inventory = store.inventory || {};
  const collection = store.collection || {};
  const inventoryCount = inventory.count ?? (Array.isArray(inventory.items) ? inventory.items.length : null);
  return [
    ["可提现 USD / RMB", `${money(goodsUsd.withdrawable, "$")} / ${money(goodsRmb.withdrawable, "¥")}`],
    ["冻结款 USD / RMB", `${money(goodsUsd.frozen, "$")} / ${money(goodsRmb.frozen, "¥")}`],
    ["待结算 / 待换汇", `${money(store.pending?.toSettle, "¥")} / ${money(store.pending?.toExchange, "¥")}`],
    ["基础保证金", money(store.deposit?.baseBalance, "¥")],
    ["库存条数", inventoryCount == null ? "—" : `${inventoryCount}${inventory.truncated ? "（截断）" : ""}`],
    ["供应链欠费", store.supply?.debt ? money(store.supply.debt, "¥") : "无"],
    ["采集状态", collection.status === "stale" ? "旧数据" : "成功"],
    ["采集时间", collection.collectedAt || "—"],
  ];
}
function renderSnapshots(snapshots) {
  const box = $("#snapshotList");
  if (!snapshots.length) { box.innerHTML = `<div class="empty-state">还没有账户快照。采集机上成功跑一轮后会自动同步到这里。</div>`; return; }
  box.innerHTML = snapshots.map((snap) => {
    const stores = snap.data?.stores || {};
    const names = Object.keys(stores);
    const failed = snap.data?.failedStores || [];
    return `<div class="snapshot-wrap">
      <div class="snapshot-head">
        <h3>${esc(snap.device_id)} · ${names.length} 家店铺</h3>
        <span class="muted small">快照时间 ${esc(localTime(snap.updated_at))}${failed.length ? ` · 上轮失败 ${failed.length} 家` : ""}</span>
      </div>
      <div class="snapshot-grid">
        ${names.map((name) => `<div class="store-card">
          <h4>${esc(name)}</h4>
          ${storeRows(stores[name] || {}).map(([k, v]) => `<div class="store-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("")}
          <details><summary>查看原始数据</summary><pre>${esc(JSON.stringify(stores[name] || {}, null, 2).slice(0, 6000))}</pre></details>
        </div>`).join("")}
      </div>
    </div>`;
  }).join("");
}

/* ---------------- 运行动态 ---------------- */
function runSummaryText(run) {
  const summary = run.summary || {};
  if (summary.error) return summary.error;
  if (summary.total != null) return `${summary.ok ?? "?"}/${summary.total} 家成功${summary.failed?.length ? " · 失败：" + summary.failed.slice(0, 4).join("、") : ""}`;
  if (summary.trigger) return `触发：${summary.trigger}`;
  return JSON.stringify(summary).slice(0, 160);
}
function renderActivity(runs) {
  const box = $("#activityList");
  if (!runs.length) { box.innerHTML = `<div class="empty-activity">还没有执行记录</div>`; return; }
  box.innerHTML = runs.slice(0, 30).map((run) => {
    const cls = statusClass(run.status);
    return `<details class="activity-item">
      <summary class="activity-head">
        <span class="activity-time">${esc(localTime(run.finished_at))}</span>
        <span class="pill ${cls}">${esc(STATUS_TEXT[run.status] || run.status)}</span>
        <span class="activity-text">${esc(runSummaryText(run))}</span>
      </summary>
      <pre class="log">${esc(JSON.stringify(run.summary || {}, null, 2))}</pre>
    </details>`;
  }).join("");
}

/* ---------------- 事件 ---------------- */
$("#loginBtn").addEventListener("click", login);
$("#password").addEventListener("keydown", (event) => { if (event.key === "Enter") login(); });
$("#logoutBtn").addEventListener("click", logout);
$("#refreshBtn").addEventListener("click", () => load().then(() => toast("已刷新", "ok")).catch((error) => toast(error.message, "bad")));
$("#manualRefresh").addEventListener("click", () => load().then(() => toast("已刷新", "ok")).catch((error) => toast(error.message, "bad")));
$("#manualRun").addEventListener("click", () => runNow());
$("#saveAuto").addEventListener("click", async () => {
  const device = selectedDevice();
  if (!device) return;
  try {
    await api("save_config", { deviceId: device.id, enabled: $("#autoEnabled").checked, intervalHours: Math.max(1, Math.min(168, Number($("#autoHours").value) || 2)) });
    toast("已保存，等设备心跳确认", "ok");
    await load();
  } catch (error) { toast(error.message, "bad"); }
});

function startPoll() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => { if (state.session) load().catch(() => {}); }, 20000);
}
state.session = loadSession();
if (state.session) boot().catch(() => { state.session = null; saveSession(null); show("login"); });
else show("login");
startPoll();