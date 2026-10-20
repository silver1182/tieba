/* ================================================================
 * 我的冒险 · 篝火社区 前端应用
 * 阶段4：前端重构 —— 底部导航 5 页（角色/背包/副本/铁匠铺/商店）
 * 保留：登录注册（邀请码门槛）、个人资料、实时聊天
 * 移除：发帖/回复/点赞/收藏/活动/通知/游戏页
 * ================================================================ */

'use strict';

/* ---------- 工具函数 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = isErr ? 'show err' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { data = {}; }
  /* 未登录/会话失效统一处理：登录、注册、me 除外（它们各自有自己的 401 语义） */
  if (res.status === 401 && !/\/api\/(login|register|me)(\/|$)/.test(path)) {
    showAuth();
    throw new Error(data.error || '登录已失效，请重新登录');
  }
  if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));
  return data;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const AVATAR_COLORS = ['#f59e0b', '#79e1c2', '#f472b6', '#a78bfa', '#60a5fa', '#fb923c', '#34d399', '#f87171', '#38bdf8', '#c084fc'];
function avatarDataUri(name, color) {
  const s = (name || '?').slice(0, 1).toUpperCase();
  const c = color && AVATAR_COLORS.includes(color) ? color : '#f59e0b';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="40" fill="${c}"/><text x="40" y="52" font-family="Arial,sans-serif" font-size="36" font-weight="700" fill="#1a120b" text-anchor="middle">${s}</text></svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
}
function avatarImg(user) {
  if (!user) return '';
  if (user.avatar) return `<img class="avatar" src="${esc(user.avatar)}" alt="">`;
  const src = avatarDataUri(user.display_name || user.username, user.avatar_color);
  return `<img class="avatar" src="${src}" alt="">`;
}

function openModal(html) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-mask" data-action="close-modal"><div class="modal glass">${html}</div></div>`;
  root.classList.remove('hidden');
  $('#modalRoot .modal input:first-of-type')?.focus();
}
function closeModal() {
  const root = $('#modalRoot');
  root.classList.add('hidden');
  root.innerHTML = '';
}
$('#modalRoot')?.addEventListener('click', e => {
  if (e.target.closest('[data-action="close-modal"]') && !e.target.closest('.modal')) closeModal();
});

/* ---------- RPG 展示辅助 ---------- */
const QUALITY_CN = { normal: '普通', fine: '优良', superb: '精良', rare: '稀有', legendary: '传说' };
const QUALITY_CLASS = { normal: 'q-normal', fine: 'q-fine', superb: 'q-superb', rare: 'q-rare', legendary: 'q-legendary' };
/* 战力兜底：后端未返回 power 时按属性估算（生命 + 攻×3 + 防×2 + 暴击×1.5 + 爆伤×0.5 + 金币加成×2） */
function calcPower(c) {
  return Math.floor((c.max_hp || 0) + (c.attack || 0) * 3 + (c.defense || 0) * 2 + (c.crit_rate || 0) * 1.5 + (c.crit_dmg || 0) * 0.5 + (c.gold_bonus || 0) * 2);
}
const TYPE_CN = { weapon: '武器', armor: '护甲', accessory: '饰品', consumable: '消耗品', material: '材料', quest: '任务物品' };
const TYPE_ICO = { weapon: '⚔️', armor: '🛡️', accessory: '📿', consumable: '🧪', material: '🪵', quest: '🗺️' };
const RACE_INFO = {
  '人族': { ico: '🧑', tag: '坚韧', desc: '生命上限 +10 · 战败金币损失 5%' },
  '精灵': { ico: '🧝', tag: '精准', desc: '暴击率 +10% · 防御 -1 · 掉落加成 5%' },
  '矮人': { ico: '🧔', tag: '锻体', desc: '防御 +3 · Boss 伤害减免 10% · 暴击率 -5%' },
  '魔族': { ico: '😈', tag: '狂热', desc: '攻击 +4 · 低血时攻击 +6 · 战败金币损失 15%' }
};
const STAT_CN = {
  max_hp: '生命上限', attack: '攻击', defense: '防御', crit_rate: '暴击率',
  crit_dmg: '暴击伤害', gold_bonus: '金币加成', heal_pct: '治疗',
  beast_hp_low_dmg: '野兽低血增伤', beast_dmg_reduce: '野兽减伤', undead_dmg: '对黑雾增伤',
  big_hit_reduce: '重击减免', high_hp_reduce: '高血减伤', death_save: '免死', heal_pct_penalty: '治疗惩罚'
};
const PCT_KEYS = ['crit_rate', 'crit_dmg', 'gold_bonus', 'heal_pct', 'beast_dmg_reduce', 'undead_dmg', 'high_hp_reduce', 'heal_pct_penalty'];

const STAT_COLOR = {
  max_hp: 'st-hp', attack: 'st-atk', defense: 'st-def',
  crit_rate: 'st-crit', crit_dmg: 'st-critd', gold_bonus: 'st-gold'
};
const MONSTER_EMOJI = {
  '灰牙野狼': '🐺', '腐木妖': '🌳', '林间盗匪': '🥷', '黑斑巨狼': '🐺', '灰烬狼王': '🐺👑',
  '矿坑蝙蝠': '🦇', '黑铁傀儡': '🤖', '黑雾祭司': '🧙', '黑铁守卫': '🛡️', '矿坑领主莫拉克': '👹'
};
function statsText(stats) {
  if (!stats) return '';
  return Object.entries(stats).map(([k, v]) => {
    const n = Number(v);
    if (!n) return ''; // 数值为 0 不显示该条，避免无意义噪声
    const label = STAT_CN[k] || k;
    const pct = PCT_KEYS.includes(k) && k !== 'death_save';
    const sign = n > 0 ? '+' : '-';
    return `<span class="${STAT_COLOR[k] || 'st-other'}">${label} ${sign}${Math.abs(n)}${pct ? '%' : ''}</span>`;
  }).filter(Boolean).join(' · ');
}
function qualityBadge(q) { return `<span class="q-badge ${QUALITY_CLASS[q] || 'q-normal'}">${QUALITY_CN[q] || q}</span>`; }

/* ---------- 全局状态 ---------- */
let ME = null;
let rpg = { char: null, gold: 0, backpack: null, dungeon: null, forge: null, shop: null, goals: null };
let currentBackpackTab = 'equipment';
let currentForgeTab = 'material';
let currentShopTab = 'all';
let shopBuying = false;
let forgeBusy = false;
let dungeonSession = null; // { chapter, events, idx } 前端副本会话缓存
let pendingRandomEvent = null; // { id,title,desc,choices } P2 随机事件待处理缓存
let chatOpen = window.matchMedia('(min-width: 1025px)').matches;
let currentMarketTab = 'all'; // 交易行：在售 / 我的
let marketBusy = false; // 交易行请求互斥
let marketPage = 1; // 交易行当前页

/* ---------- 导航 ---------- */
function setNav(view) {
  $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}
function switchView(view) {
  setNav(view);
  if (view === 'character') viewCharacter();
  else if (view === 'backpack') viewBackpack();
  else if (view === 'dungeon') viewDungeon();
  else if (view === 'forge') viewForge();
  else if (view === 'shop') viewShop();
  else if (view === 'market') viewMarket();
}

/* ---------- 全局事件委托 ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'nav') switchView(el.dataset.view);
  else if (a === 'create-char') createCharacter(el.dataset.race);
  else if (a === 'equip') equipItem(el.dataset.id);
  else if (a === 'unequip') unequipItem(el.dataset.id);
  else if (a === 'bp-tab') { currentBackpackTab = el.dataset.tab; renderBackpackList(); }
  else if (a === 'forge-tab') { currentForgeTab = el.dataset.tab; renderForgeList(); }
  else if (a === 'forge-qty') updateForgeQty(el.dataset.index);
  else if (a === 'forge') forgeItem(el.dataset.kind, el.dataset.key, Number(el.dataset.index));
  else if (a === 'dungeon-start') startDungeon();
  else if (a === 'dungeon-event') dungeonEvent(el.dataset.choice || '');
  else if (a === 'dungeon-settle') dungeonSettle();
  else if (a === 'goal-claim') claimGoal(Number(el.dataset.id));
  else if (a === 'daily-claim') claimDailyTask(Number(el.dataset.slot));
  else if (a === 'rpg-event-open') showRandomEventCard(pendingRandomEvent);
  else if (a === 'rpg-event-choose') chooseRandomEvent(Number(el.dataset.choice));
  else if (a === 'dungeon-info') showDungeonInfo(el.dataset.chapter);
  else if (a === 'save-settings') saveDungeonSettings();
  else if (a === 'shop-tab') { currentShopTab = el.dataset.tab; renderShopList(); }
  else if (a === 'shop-qty') updateShopQty(el.dataset.index);
  else if (a === 'shop-buy') shopBuy(Number(el.dataset.index));
  else if (a === 'market-tab') { currentMarketTab = el.dataset.tab; marketPage = 1; renderMarketAll(); }
  else if (a === 'market-filter') { marketPage = 1; renderMarketAll(); }
  else if (a === 'market-page') { marketPage = Number(el.dataset.page); renderMarketList(); }
  else if (a === 'market-sell') openMarketSell();
  else if (a === 'market-sell-item') selectMarketSellItem(Number(el.dataset.index));
  else if (a === 'market-sell-submit') submitMarketSell();
  else if (a === 'market-buy') marketBuy(Number(el.dataset.id));
  else if (a === 'market-cancel') marketCancel(Number(el.dataset.id));
  else if (a === 'go-backpack') { closeModal(); switchView('backpack'); }
  else if (a === 'open-profile') { switchView('profile'); }
  else if (a === 'close-modal') closeModal();
  else if (a === 'edit-profile') openEditProfile();
  else if (a === 'change-password') openChangePassword();
  else if (a === 'manage-sessions') openSessionsModal();
  else if (a === 'kick-session') kickSession(el.dataset.id);
});

/* ================================================================
 * 登录 / 注册（保留：邀请码门槛）
 * ================================================================ */
const PW_RULES = [
  ['至少 8 位', v => v.length >= 8],
  ['同时包含字母与数字', v => /[A-Za-z]/.test(v) && /\d/.test(v)],
  ['无中文', v => !/[\u4e00-\u9fa5]/.test(v)]
];
function pwValid(pw) { return PW_RULES.every(([, fn]) => fn(pw)); }

function renderAuth() {
  $('#authCard').innerHTML = `
    <div class="auth-tabs">
      <button id="tabLogin" class="active">登录</button>
      <button id="tabRegister">注册</button>
    </div>
    <div id="authLogin">
      <h2 class="auth-title">欢迎回来 ✦</h2>
      <p class="auth-sub">围坐在篝火旁，继续你的冒险</p>
      <label class="field"><span>账号</span><input id="loginUser" maxlength="30" autocomplete="username" placeholder="用户名"></label>
      <label class="field"><span>密码</span><input id="loginPass" type="password" maxlength="72" autocomplete="current-password" placeholder="密码"></label>
      <button class="primary full" id="loginBtn">登录</button>
      <p class="form-tip">还没有账号？<a href="#" id="toRegister">去注册</a></p>
    </div>
    <div id="authRegister" class="hidden">
      <h2 class="auth-title">加入篝火 ✦</h2>
      <p class="auth-sub">本社区采用邀请制，需要邀请码才能加入</p>
      <label class="field"><span>邀请码</span><input id="regInvite" maxlength="40" placeholder="邀请码"></label>
      <label class="field"><span>用户名</span><input id="regUser" maxlength="30" autocomplete="username" placeholder="用户名"></label>
      <label class="field"><span>密码</span><input id="regPass" type="password" maxlength="72" autocomplete="new-password" placeholder="密码"></label>
      <label class="field"><span>确认密码</span><input id="regPass2" type="password" maxlength="72" autocomplete="new-password" placeholder="再次输入密码"></label>
      <p class="hint-list" id="regHint"></p>
      <button class="primary full" id="registerBtn">注册</button>
      <p class="form-tip">已有账号？<a href="#" id="toLogin">去登录</a></p>
    </div>`;
  $('#tabLogin').onclick = () => { $('#authLogin').classList.remove('hidden'); $('#authRegister').classList.add('hidden'); $('#tabLogin').classList.add('active'); $('#tabRegister').classList.remove('active'); };
  $('#tabRegister').onclick = () => { $('#authLogin').classList.add('hidden'); $('#authRegister').classList.remove('hidden'); $('#tabRegister').classList.add('active'); $('#tabLogin').classList.remove('active'); };
  $('#toRegister').onclick = e => { e.preventDefault(); $('#tabRegister').click(); };
  $('#toLogin').onclick = e => { e.preventDefault(); $('#tabLogin').click(); };
  $('#loginBtn').onclick = doLogin;
  $('#registerBtn').onclick = doRegister;
  $('#loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('#regPass').addEventListener('input', () => renderPwHint());
  ['loginUser', 'loginPass', 'regInvite', 'regUser', 'regPass', 'regPass2'].forEach(id => {
    $('#' + id).addEventListener('keydown', e => { if (e.key === 'Enter') { id.startsWith('login') ? doLogin() : doRegister(); } });
  });
}

function renderPwHint() {
  const pw = $('#regPass').value;
  $('#regHint').innerHTML = PW_RULES.map(([label, fn]) =>
    `<span class="rule ${fn(pw) ? 'ok' : 'bad'}">${fn(pw) ? '✓' : '✗'} ${label}</span>`).join('');
}

async function doLogin() {
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  if (!username || !password) return toast('请输入账号和密码', true);
  try {
    await api('/api/login', { method: 'POST', body: { username, password } });
    const me = await api('/api/me');
    ME = me.user || me;
    enterShell();
    toast('欢迎回来，' + (ME.display_name || ME.username));
  } catch (e) { toast(e.message, true); }
}

async function doRegister() {
  const invite = $('#regInvite').value.trim();
  const username = $('#regUser').value.trim();
  const password = $('#regPass').value;
  const password2 = $('#regPass2').value;
  if (!invite) return toast('请输入邀请码', true);
  if (!username) return toast('请输入用户名', true);
  if (!pwValid(password)) return toast('密码需至少 8 位且同时包含字母与数字', true);
  if (password !== password2) return toast('两次输入的密码不一致', true);
  try {
    await api('/api/register', { method: 'POST', body: { invite, username, password } });
    const u = await api('/api/me');
    ME = u.user || u;
    enterShell();
    toast('注册成功，欢迎加入篝火！');
  } catch (e) { toast(e.message, true); }
}

/* ================================================================
 * 聊天室（保留：实时聊天）
 * ================================================================ */
let ws = null, chatReconnect = null;

function connectChat() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => { $('#chatSend').disabled = false; toast('已连接聊天室'); };
  ws.onclose = () => {
    $('#chatSend').disabled = true;
    clearTimeout(chatReconnect);
    chatReconnect = setTimeout(connectChat, 3000);
  };
  ws.onmessage = ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'presence') { $('#onlineCount').textContent = (msg.payload || []).length; }
    else if (msg.type === 'message') addChatMsg(msg.payload || msg);
  };
}

function addChatMsg(msg) {
  const wrap = $('#chatMessages');
  const isMe = ME && msg.user_id === ME.id;
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isMe ? ' mine' : '');
  div.innerHTML = `${avatarImg(msg)}<div class="msg-body"><span class="msg-name">${esc(msg.display_name || msg.username)}</span><span class="msg-time">${fmtTime(msg.created)}</span><div class="msg-text">${esc(msg.body)}</div></div>`;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  while (wrap.children.length > 200) wrap.removeChild(wrap.firstChild);
}

async function sendChat() {
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return toast('聊天室未连接', true);
  input.value = '';
  try { ws.send(JSON.stringify({ body: text })); }
  catch (e) { toast(e.message, true); input.value = text; }
}

function bindChat() {
  $('#chatSend').onclick = sendChat;
  $('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  $('#emojiBtn').onclick = e => { e.stopPropagation(); $('#emojiPop').classList.toggle('hidden'); };
  document.addEventListener('click', e => { if (!e.target.closest('.chat-input')) $('#emojiPop').classList.add('hidden'); });
  const EMOJIS = ['😀','😂','🥰','😎','🤔','😭','👍','👏','🔥','⭐','🎉','🍺','🍗','⚔️','🛡️','🗺️','🐺','🧟','💀','🪙'];
  $('#emojiPop').innerHTML = EMOJIS.map(x => `<button type="button" class="emoji">${x}</button>`).join('');
  $('#emojiPop').addEventListener('click', e => {
    const b = e.target.closest('.emoji');
    if (!b) return;
    const inp = $('#chatInput');
    inp.value += b.textContent;
    inp.focus();
  });
  $('#chatCloseBtn').onclick = () => setChatOpen(false);
  $('#chatToggleBtn').onclick = () => setChatOpen(true);
}

function setChatOpen(open) {
  chatOpen = open;
  const panel = $('#chatPanel'), fab = $('#chatToggleBtn');
  panel.classList.toggle('open', open);
  fab.classList.toggle('hidden', open);
  $('#chatCloseBtn').classList.toggle('hidden', !open);
  if (open) $('#chatInput').focus();
}

/* ================================================================
 * 个人资料（保留：资料编辑 / 改密码）
 * ================================================================ */
async function viewProfile() {
  setNav('profile');
  $('#view').innerHTML = '<p class="empty-tip">加载中…</p>';
  try {
    const d = await api('/api/me');
    const u = d.user || d;
    let rpgHtml = '';
    try {
      const c = await api('/api/rpg/character');
      const ch = c.character;
      rpgHtml = `<div class="profile-rpg glass"><h3>冒险档案</h3><p><b>${RACE_INFO[ch.race]?.ico || ''} ${esc(ch.race)}</b> · Lv.${ch.level} · 🪙 ${ch.gold}</p><p>经验 ${ch.exp} / ${ch.level * 100} · 生命 ${ch.cur_hp}/${ch.max_hp}</p><p>第一章 Boss 击杀 ${ch.boss_kills_ch1} 次 · 第二章 Boss 击杀 ${ch.boss_kills_ch2} 次</p></div>`;
    } catch { rpgHtml = `<div class="profile-rpg glass"><h3>冒险档案</h3><p>尚未创建角色，前往「角色」页开始冒险吧。</p></div>`; }
    $('#view').innerHTML = `
      <div class="profile-head glass">
        ${avatarImg(u)}
        <div>
          <h2>${esc(u.display_name || u.username)}</h2>
          <p class="muted">@${esc(u.username)} · 加入于 ${fmtDate(u.created)}</p>
          ${u.title ? `<p class="profile-title">${esc(u.title)}</p>` : ''}
        </div>
        <div class="profile-actions">
          <button class="primary" data-action="edit-profile">编辑资料</button>
          <button class="ghost" data-action="change-password">修改密码</button>
          <button class="ghost" data-action="manage-sessions">会话管理</button>
        </div>
      </div>
      ${rpgHtml}`;
  } catch (e) {
    $('#view').innerHTML = `<p class="empty-tip">加载失败：${esc(e.message)}</p>`;
  }
}

function openEditProfile() {
  openModal(`
    <h3 class="modal-title">编辑资料</h3>
    <label class="field"><span>显示名</span><input id="editDisplay" maxlength="30" value="${esc(ME.display_name || '')}" placeholder="显示名"></label>
    <label class="field"><span>称号</span><input id="editTitle" maxlength="30" value="${esc(ME.title || '')}" placeholder="自定义称号"></label>
    <label class="field"><span>头像颜色</span><div class="color-row">${AVATAR_COLORS.map(c => `<button type="button" class="color-dot" data-color="${c}" style="background:${c}"></button>`).join('')}</div></label>
    <div class="modal-actions">
      <button class="primary" id="saveProfileBtn">保存</button>
      <button class="ghost" data-action="close-modal">取消</button>
    </div>`);
  let chosen = ME.avatar_color || '';
  $('#modalRoot .color-dot').forEach(b => {
    b.classList.toggle('active', b.dataset.color === chosen);
    b.onclick = () => { chosen = b.dataset.color; $('#modalRoot .color-dot').forEach(x => x.classList.toggle('active', x === b)); };
  });
  $('#saveProfileBtn').onclick = async () => {
    try {
      const d = await api('/api/me', { method: 'PATCH', body: { display_name: $('#editDisplay').value.trim() || ME.username, title: $('#editTitle').value.trim(), avatar_color: chosen } });
      ME = d.user || d;
      closeModal();
      viewProfile();
      renderSideAccount();
      toast('资料已更新');
    } catch (e) { toast(e.message, true); }
  };
}

function openChangePassword() {
  openModal(`
    <h3 class="modal-title">修改密码</h3>
    <label class="field"><span>当前密码</span><input id="oldPass" type="password" maxlength="72" autocomplete="current-password"></label>
    <label class="field"><span>新密码</span><input id="newPass" type="password" maxlength="72" autocomplete="new-password"></label>
    <label class="field"><span>确认新密码</span><input id="newPass2" type="password" maxlength="72" autocomplete="new-password"></label>
    <p class="form-tip">新密码需至少 8 位且同时包含字母与数字</p>
    <div class="modal-actions">
      <button class="primary" id="changePwBtn">确认修改</button>
      <button class="ghost" data-action="close-modal">取消</button>
    </div>`);
  $('#changePwBtn').onclick = async () => {
    const oldPass = $('#oldPass').value, np = $('#newPass').value, np2 = $('#newPass2').value;
    if (!pwValid(np)) return toast('新密码需至少 8 位且同时包含字母与数字', true);
    if (np !== np2) return toast('两次输入的新密码不一致', true);
    try {
      await api('/api/me/password', { method: 'PATCH', body: { old_password: oldPass, new_password: np } });
      closeModal();
      toast('密码已修改');
    } catch (e) { toast(e.message, true); }
  };
}

function deviceLabel(ua) {
  if (!ua) return '未知设备';
  const m = String(ua).match(/MicroMessenger|Edg\/\d+|Chrome\/\d+|Firefox\/\d+|Safari\/\d+|Windows|iPhone|Android|Macintosh/);
  return m ? m[0].replace(/\d+$/, '') : String(ua).slice(0, 40);
}

async function openSessionsModal() {
  openModal('<h3 class="modal-title">会话管理</h3><p class="form-tip">加载中…</p>');
  try {
    const d = await api('/api/sessions');
    const list = d.sessions || [];
    $('#modalRoot .modal').innerHTML = `
      <h3 class="modal-title">登录设备 / 会话管理</h3>
      <p class="form-tip">同一账号同时仅保留一个有效会话，新登录会自动踢除旧会话。</p>
      <div class="session-list">
        ${list.map(s => `
          <div class="session-item glass">
            <div class="session-info">
              <b>${esc(deviceLabel(s.ua))}</b>${s.current ? ' <span class="q-badge q-fine">当前</span>' : ''}
              <div class="muted">ID ${esc(s.id)} · 登录于 ${fmtDate(s.created_at)} ${fmtTime(s.created_at)} · 过期 ${fmtDate(s.expires)}</div>
            </div>
            ${s.current ? '' : `<button class="ghost sm" data-action="kick-session" data-id="${esc(s.id)}">踢除</button>`}
          </div>`).join('') || '<p class="empty-tip">暂无会话记录</p>'}
      </div>
      <div class="modal-actions">
        <button class="ghost" data-action="close-modal">关闭</button>
      </div>`;
  } catch (e) {
    $('#modalRoot .modal').innerHTML = `<h3 class="modal-title">会话管理</h3><p class="empty-tip">加载失败：${esc(e.message)}</p><div class="modal-actions"><button class="ghost" data-action="close-modal">关闭</button></div>`;
  }
}

async function kickSession(id) {
  if (!id) return;
  try {
    await api('/api/sessions/kick', { method: 'POST', body: { id } });
    toast('已踢除该会话');
    openSessionsModal();
  } catch (e) { toast(e.message, true); }
}

function renderSideAccount() {
  if (!ME) return;
  $('#sideAccount').innerHTML = `
    <button class="account-btn" data-action="open-profile">
      ${avatarImg(ME)}
      <div><div class="acct-name">${esc(ME.display_name || ME.username)}</div><div class="acct-sub">@${esc(ME.username)}</div></div>
    </button>`;
}

/* ================================================================
 * RPG —— 角色页
 * ================================================================ */
function expNeed(level) { return level * 100; }

async function viewCharacter() {
  setNav('character');
  $('#view').innerHTML = '<p class="empty-tip">加载中…</p>';
  try {
    const d = await api('/api/rpg/character');
    rpg.char = d.character;
    rpg.gold = d.character.gold;
    updateGold();
    let st = null;
    try { st = await api('/api/rpg/dungeon/status'); rpg.dungeon = st; } catch {}
    let dt = null;
    try { dt = await api('/api/rpg/daily-tasks'); rpg.daily = dt; } catch {}
    $('#view').innerHTML = renderCharacter(d.character, st, dt);
  } catch (e) {
    rpg.char = null;
    if (/尚未创建角色/.test(e.message)) $('#view').innerHTML = renderCharacterCreate();
    else { toast(e.message, true); $('#view').innerHTML = '<p class="empty-tip">加载失败</p>'; }
  }
}

function renderCharacterCreate() {
  return `
    <div class="page-title"><h2>创建角色</h2><p class="muted">选择你的种族，开启篝火冒险</p></div>
    <div class="race-grid">
      ${Object.entries(RACE_INFO).map(([race, info]) => `
        <div class="race-card glass">
          <div class="race-ico">${info.ico}</div>
          <div class="race-name">${esc(race)} <span class="race-tag">${info.tag}</span></div>
          <p class="race-desc">${info.desc}</p>
          <button class="primary full" data-action="create-char" data-race="${esc(race)}">选择此种族</button>
        </div>`).join('')}
    </div>`;
}

async function createCharacter(race) {
  try {
    const d = await api('/api/rpg/character/create', { method: 'POST', body: { race } });
    rpg.char = d.character;
    rpg.gold = d.character.gold;
    updateGold();
    toast('角色创建成功！');
    viewCharacter();
  } catch (e) { toast(e.message, true); }
}

function renderCharacter(c, st, dt) {
  const hpPct = c.max_hp ? Math.round(c.cur_hp / c.max_hp * 100) : 0;
  const race = RACE_INFO[c.race] || { ico: '🎮', tag: '' };
  const slots = [
    { loc: 'weapon', label: '武器', ico: '⚔️' },
    { loc: 'armor', label: '护甲', ico: '🛡️' },
    { loc: 'accessory', label: '饰品', ico: '📿' }
  ];
  const equipped = (c.equipped || []).filter(x => x.location && x.location.startsWith('equipped_'));
  const getEquipped = loc => equipped.find(x => x.location === 'equipped_' + loc);
  const remaining = st ? st.remaining : Math.max(0, 5 - (c.daily_count || 0));

  return `
    <div class="page-title"><h2>角色</h2><p class="muted">整备装备，准备出发</p></div>

    <section class="panel glass rpg-head">
      <div class="rpg-head-top">
        <div class="char-ico">${race.ico}</div>
        <div class="char-meta">
          <div class="char-name">Lv.${c.level} ${esc(c.race)}</div>
          <div class="exp-row"><div class="exp-bar"><i style="width:${c.level >= 6 ? 100 : Math.min(100, Math.round(c.exp / expNeed(c.level) * 100))}%"></i></div><span class="exp-text">${c.level >= 6 ? '经验 MAX' : `经验 ${c.exp} / ${expNeed(c.level)}${c.exp < expNeed(c.level) ? ` · 升级还需 ${expNeed(c.level) - c.exp}` : ''}`}</span></div>
        </div>
        <div class="gold-big">🪙 ${c.gold}</div>
      </div>
      <div class="hp-row"><span>生命</span><div class="hp-bar"><i style="width:${hpPct}%"></i></div><span class="v-hp">${c.cur_hp} / ${c.max_hp}</span></div>
      <div class="power-row"><span>战力</span><b class="v-power">${c.power != null ? c.power : calcPower(c)}</b></div>
    </section>

    <section class="panel glass">
      <h3 class="panel-title">属性</h3>
      <div class="attr-grid">
        <div class="attr-cell"><span>攻击</span><b class="v-atk">${c.attack}</b></div>
        <div class="attr-cell"><span>防御</span><b class="v-def">${c.defense}</b></div>
        <div class="attr-cell"><span>暴击率</span><b class="v-crit">${c.crit_rate}%</b></div>
        <div class="attr-cell"><span>暴击伤害</span><b class="v-critd">${c.crit_dmg}%</b></div>
        <div class="attr-cell"><span>金币加成</span><b class="v-gold">${c.gold_bonus}%</b></div>
        <div class="attr-cell"><span>今日副本</span><b>${remaining} 次</b></div>
        <div class="attr-cell"><span>一章 Boss</span><b>${c.boss_kills_ch1} 次</b></div>
        <div class="attr-cell"><span>二章 Boss</span><b>${c.boss_kills_ch2} 次</b></div>
      </div>
    </section>

    <section class="panel glass">
      <h3 class="panel-title">装备栏</h3>
      <div class="equip-grid">
        ${slots.map(s => {
          const it = getEquipped(s.loc);
          return `<div class="equip-slot">
            <div class="slot-ico">${s.ico}</div>
            <div class="slot-label">${s.label}</div>
            ${it ? `
              <div class="slot-item ${QUALITY_CLASS[it.quality] || 'q-normal'}">
                <div class="slot-name">${esc(it.name)} ${qualityBadge(it.quality)}</div>
                <div class="slot-stats">${statsText(it.stats)}</div>
                ${it.desc ? `<div class="slot-desc">${esc(it.desc)}</div>` : ''}
                <button class="ghost sm" data-action="unequip" data-id="${it.id}">卸下</button>
              </div>` : `<div class="slot-empty">空位</div>`}
          </div>`;
        }).join('')}
      </div>
    </section>

    ${renderDailyPanel(dt && dt.tasks)}`;
}

/* ================================================================
 * RPG —— 背包页
 * ================================================================ */
async function viewBackpack() {
  setNav('backpack');
  $('#view').innerHTML = '<p class="empty-tip">加载中…</p>';
  try {
    const d = await api('/api/rpg/backpack');
    rpg.backpack = d.backpack;
    rpg.gold = d.gold;
    updateGold();
    $('#view').innerHTML = `
      <div class="page-title"><h2>背包</h2><p class="muted">管理你的冒险收获</p></div>
      <div class="tabs" id="bpTabs">
        <button data-action="bp-tab" data-tab="equipment" class="active">装备</button>
        <button data-action="bp-tab" data-tab="consumable">消耗品</button>
        <button data-action="bp-tab" data-tab="material">材料</button>
        <button data-action="bp-tab" data-tab="quest">任务物品</button>
      </div>
      <div id="bpList"></div>`;
    renderBackpackList();
  } catch (e) {
    if (/尚未创建角色/.test(e.message)) { $('#view').innerHTML = `<p class="empty-tip">尚未创建角色，请先前往「角色」页创建。</p>`; }
    else { toast(e.message, true); $('#view').innerHTML = '<p class="empty-tip">加载失败</p>'; }
  }
}

function renderBackpackList() {
  $$('#bpTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === currentBackpackTab));
  const b = rpg.backpack;
  if (!b) return;
  const wrap = $('#bpList');
  const eq = b.equipment || [];
  const group = {
    equipment: eq,
    consumable: b.consumable || [],
    material: b.material || [],
    quest: b.quest || []
  }[currentBackpackTab] || [];
  if (!group.length) {
    wrap.innerHTML = `<p class="empty-tip">空空如也，去副本或商店里获得一些物品吧。</p>`;
    return;
  }
  if (currentBackpackTab === 'equipment') {
    wrap.innerHTML = `<div class="item-grid">${group.map(it => `
      <div class="item-card ${QUALITY_CLASS[it.quality] || 'q-normal'}">
        <div class="item-ico">${TYPE_ICO[it.type] || '📦'}</div>
        <div class="item-name">${esc(it.name)} ${qualityBadge(it.quality)}</div>
        <div class="item-stats">${statsText(it.stats)}</div>
        ${it.desc ? `<div class="item-desc">${esc(it.desc)}</div>` : ''}
        <button class="primary sm" data-action="equip" data-id="${it.id}">装备</button>
      </div>`).join('')}</div>`;
  } else {
    wrap.innerHTML = `<div class="stack-list">${group.map(it => `
      <div class="stack-row glass">
        <span class="stack-ico">${TYPE_ICO[it.type] || '📦'}</span>
        <span class="stack-name">${esc(it.name)}${it.quality && it.quality !== 'normal' ? ' ' + qualityBadge(it.quality) : ''}</span>
        ${it.stats && Object.keys(it.stats).length ? `<span class="stack-stats">${statsText(it.stats)}</span>` : ''}
        <span class="stack-qty">×${it.quantity}</span>
      </div>`).join('')}</div>`;
  }
}

async function equipItem(id) {
  try {
    const d = await api('/api/rpg/equipment/equip', { method: 'POST', body: { item_id: Number(id) } });
    rpg.char = d.character; rpg.gold = d.character.gold; updateGold();
    toast('装备成功，战力 ' + d.character.power);
    await viewBackpack();
  } catch (e) { toast(e.message, true); }
}

async function unequipItem(id) {
  try {
    const d = await api('/api/rpg/equipment/unequip', { method: 'POST', body: { item_id: Number(id) } });
    rpg.char = d.character; rpg.gold = d.character.gold; updateGold();
    toast('已卸下装备，战力 ' + d.character.power);
    const view = document.querySelector('[data-view].active')?.dataset.view;
    if (view === 'backpack') await viewBackpack(); else viewCharacter();
  } catch (e) { toast(e.message, true); }
}

/* ================================================================
 * RPG —— 副本页
 * ================================================================ */
async function viewDungeon() {
  setNav('dungeon');
  $('#view').innerHTML = '<p class="empty-tip">加载中…</p>';
  try {
    const [st, gl, evt] = await Promise.all([
      api('/api/rpg/dungeon/status'),
      api('/api/rpg/goals'),
      api('/api/rpg/events').catch(() => ({ event: null }))
    ]);
    rpg.dungeon = st;
    rpg.goals = gl.goals || [];
    pendingRandomEvent = evt.event || null;
    $('#view').innerHTML = renderDungeonPage(st);
  } catch (e) {
    if (/尚未创建角色/.test(e.message)) { $('#view').innerHTML = `<p class="empty-tip">尚未创建角色，请先前往「角色」页创建。</p>`; }
    else { toast(e.message, true); $('#view').innerHTML = '<p class="empty-tip">加载失败</p>'; }
  }
}

function renderDungeonPage(st) {
  const ap = st.auto_potion || { enabled: true, threshold: 35, limit: 1 };
  const ch2Locked = !st.ch2_unlocked;
  const pendingBanner = pendingRandomEvent ? `
    <section class="panel glass">
      <h3 class="panel-title">✨ 随机事件待处理</h3>
      <p class="muted">${esc(pendingRandomEvent.title)}：${esc(pendingRandomEvent.desc)}</p>
      <div class="dungeon-actions"><button class="primary" data-action="rpg-event-open">查看事件</button></div>
    </section>` : '';
  if (st.in_dungeon) {
    const p = st.dungeon_progress || {};
    const hasCache = !!dungeonSession;
    const ended = !hasCache && (p.finished || p.failed);
    const doneCount = hasCache ? dungeonSession.idx : Math.max(0, p.next_slot - 1);
    const curEv = hasCache ? dungeonSession.events[dungeonSession.idx] : null;
    const encounterChoices = !ended && curEv && curEv.type === 'encounter' && curEv.choices && curEv.choices.length
      ? `<div class="event-choices">${curEv.choices.map((c, i) => `<button class="choice" data-action="dungeon-event" data-choice="${i + 1}">${esc(c)}</button>`).join('')}</div>` : '';
    return `
      ${pendingBanner}
      <div class="page-title"><h2>副本</h2><p class="muted">${ended ? (p.failed ? `本次副本失败 · 第 ${p.chapter} 章` : `副本已结束 · 第 ${p.chapter} 章`) : `正在进行 · 第 ${p.chapter} 章`}</p></div>
      <section class="panel glass">
        <h3 class="panel-title">事件进度</h3>
        ${hasCache ? renderEventTrack(dungeonSession.events, dungeonSession.idx) : ended ? `<p class="empty-tip">本次副本${p.failed ? '失败' : '通关'}（已完成 ${Math.min(p.next_slot - 1, p.total)}/${p.total} 个事件），请点击「结算副本」领取结算与战报。</p>` : `<p class="empty-tip">副本进行中（第 ${Math.min(p.next_slot, p.total)}/${p.total} 个事件）。刷新页面后无法预览事件，可继续挑战或直接结算。</p>`}
        ${encounterChoices}
        <div class="dungeon-actions">
          ${ended ? '' : `<button class="primary" data-action="dungeon-event">${hasCache ? '挑战当前事件' : '继续挑战'}</button>`}
          <button class="ghost" data-action="dungeon-settle">结算副本</button>
        </div>
      </section>
      <section class="panel glass">
        <h3 class="panel-title">自动战斗设置</h3>
        ${renderSettingsForm(ap)}
      </section>
      ${renderGoalsPanel(rpg.goals)}
      ${renderDungeonSummary(st)}`;
  }
  return `
    ${pendingBanner}
    <div class="page-title"><h2>副本</h2><p class="muted">深入未知，寻找宝藏</p></div>
    <section class="panel glass">
      <h3 class="panel-title">选择章节</h3>
      <div class="chapter-grid">
        <div class="chapter-card ${st.chapter === 1 ? 'active' : ''}">
          <div class="chapter-ico">🌲</div>
          <div class="chapter-name">第一章 · 灰烬森林</div>
          <p class="muted">等级 1 起 · 5 种怪物 · 3 种奇遇</p>
          <button class="chapter-info-btn" data-action="dungeon-info" data-chapter="1">📋 详情 · 掉落与剧情</button>
        </div>
        <div class="chapter-card ${st.chapter === 2 ? 'active' : ''} ${ch2Locked ? 'locked' : ''}">
          <div class="chapter-ico">⛏️</div>
          <div class="chapter-name">第二章 · 沉没矿坑</div>
          <p class="muted">${ch2Locked ? '未解锁：需要 等级≥3 且击败第一章 Boss ≥1 次' : '已解锁'}</p>
          <button class="chapter-info-btn" data-action="dungeon-info" data-chapter="2">📋 详情 · 掉落与剧情</button>
        </div>
      </div>
      <div class="dungeon-actions">
        <label class="field inline"><span>章节</span>
          <select id="dungeonChapter">
            <option value="1">第一章 · 灰烬森林</option>
            <option value="2" ${ch2Locked ? 'disabled' : ''}>第二章 · 沉没矿坑</option>
          </select>
        </label>
        <button class="primary" data-action="dungeon-start">开始副本（消耗 1 次）</button>
      </div>
    </section>
    <section class="panel glass">
      <h3 class="panel-title">自动战斗设置</h3>
      ${renderSettingsForm(ap)}
    </section>
    ${renderGoalsPanel(rpg.goals)}
    ${renderDungeonSummary(st)}`;
}

/* ---------- 章节目标（P0） ---------- */
const GOAL_ICO = { clear: '🏁', kill: '⚔️', encounter: '✨', collect: '🧺', boss: '👑' };
/* ---------- 每日任务（P1） ---------- */
const DAILY_ICO = { clear: '🏁', kill: '⚔️', forge: '🔨', shop: '🛒' };
function renderDailyPanel(tasks) {
  if (!tasks || !tasks.length) return '';
  return `<section class="panel glass">
    <h3 class="panel-title">每日任务 · ${esc(tasks[0].date || '')}</h3>
    <div class="goal-list">
      ${tasks.map(t => {
        const pct = Math.min(100, Math.round(t.progress / t.amount * 100));
        const btn = t.claimed
          ? '<span class="goal-claimed">✓ 已领取</span>'
          : t.claimable
            ? `<button class="primary small" data-action="daily-claim" data-slot="${t.slot}">领取奖励</button>`
            : '<span class="goal-locked">进行中</span>';
        return `<div class="goal-item ${t.done && !t.claimed ? 'ready' : ''}">
          <div class="goal-head">
            <span class="goal-ico">${DAILY_ICO[t.type] || '🎯'}</span>
            <span class="goal-title">${esc(t.type_cn)}：${esc(t.target)}</span>
            <span class="goal-progress">${t.progress}/${t.amount}</span>
          </div>
          <div class="goal-bar"><div class="goal-bar-fill" style="width:${pct}%"></div></div>
          <div class="goal-foot">
            <span class="goal-reward">奖励：${esc(goalRewardText(t.reward))}</span>
            ${btn}
          </div>
        </div>`;
      }).join('')}
    </div>
  </section>`;
}
async function claimDailyTask(slot) {
  try {
    const d = await api('/api/rpg/daily-tasks/claim', { method: 'POST', body: { slot } });
    rpg.gold = d.gold;
    rpg.char = d.character;
    updateGold();
    const parts = d.rewards.map(r => r.kind === 'gold'
      ? `金币×${r.quantity}`
      : r.kind === 'equip_box'
        ? `装备箱「${r.name}」(${QUALITY_CN[r.quality] || r.quality})`
        : `${r.name}×${r.quantity}`);
    toast(`每日任务领取成功：${parts.join('、')}`);
    viewCharacter();
  } catch (e) { toast(e.message, true); }
}
function goalRewardText(r) {
  const parts = [];
  if (r.gold > 0) parts.push(`金币×${r.gold}`);
  for (const it of r.items || []) {
    if (it.box) parts.push('装备箱×1（随机装备）');
    else parts.push(`${it.name}×${it.quantity || 1}`);
  }
  return parts.join('、') || '—';
}
function renderGoalsPanel(goals) {
  if (!goals || !goals.length) return '';
  return [1, 2].map(ch => {
    const list = goals.filter(g => g.chapter === ch);
    if (!list.length) return '';
    const name = ch === 1 ? '灰烬森林' : '沉没矿坑';
    return `<section class="panel glass">
      <h3 class="panel-title">章节目标 · 第 ${ch} 章 ${name}</h3>
      <div class="goal-list">
        ${list.map(g => {
          const pct = Math.min(100, Math.round(g.progress / g.amount * 100));
          const btn = g.claimed
            ? '<span class="goal-claimed">✓ 已领取</span>'
            : g.claimable
              ? `<button class="primary small" data-action="goal-claim" data-id="${g.id}">领取奖励</button>`
              : '<span class="goal-locked">进行中</span>';
          return `<div class="goal-item ${g.done && !g.claimed ? 'ready' : ''}">
            <div class="goal-head">
              <span class="goal-ico">${GOAL_ICO[g.type] || '🎯'}</span>
              <span class="goal-title">${esc(g.type_cn)}：${esc(g.target)}</span>
              <span class="goal-progress">${g.progress}/${g.amount}</span>
            </div>
            <div class="goal-bar"><div class="goal-bar-fill" style="width:${pct}%"></div></div>
            <div class="goal-foot">
              <span class="goal-reward">奖励：${esc(goalRewardText(g.reward))}</span>
              ${btn}
            </div>
          </div>`;
        }).join('')}
      </div>
    </section>`;
  }).join('');
}
async function claimGoal(goalId) {
  try {
    const d = await api('/api/rpg/goals/claim', { method: 'POST', body: { goal_id: goalId } });
    rpg.gold = d.gold;
    rpg.char = d.character;
    updateGold();
    const parts = d.rewards.map(r => r.kind === 'gold'
      ? `金币×${r.quantity}`
      : r.kind === 'equip_box'
        ? `装备箱「${r.name}」(${QUALITY_CN[r.quality] || r.quality})`
        : `${r.name}×${r.quantity}`);
    toast(`领取成功：${parts.join('、')}`);
    viewDungeon();
  } catch (e) { toast(e.message, true); }
}

// 副本选择详情：掉落物、概率、可触发剧情（简略）
async function showDungeonInfo(chapter) {
  try {
    const d = await api('/api/rpg/dungeon/info?chapter=' + encodeURIComponent(chapter));
    openModal(`<h2>${esc(d.name)} · 第 ${d.chapter} 章</h2>
      <p class="muted">怪物：${d.monsters.map(m => (m.tier === 'boss' ? '👑 ' : m.tier === 'elite' ? '💀 ' : '') + esc(m.name)).join('、')}</p>
      <h3 class="panel-title">掉落与概率</h3>
      ${d.drops.map(g => `<div class="drop-group"><b>${esc(g.name)}</b><ul>${g.items.map(it => `<li>${esc(it.name)} · ${esc(it.rate)}${it.note ? ` <span class="muted">${esc(it.note)}</span>` : ''}</li>`).join('')}</ul></div>`).join('')}
      <h3 class="panel-title">可触发剧情</h3>
      ${d.encounters.map(e => `<div class="drop-group"><b>${esc(e.name)}</b><p class="muted">${esc(e.desc)}</p></div>`).join('') || '<p class="muted">暂无剧情</p>'}
      <div class="dungeon-actions"><button class="ghost" data-action="close-modal">关闭</button></div>`);
  } catch (e) { toast(e.message, true); }
}

function renderDungeonSummary(st) {
  return `
    <section class="panel glass">
      <h3 class="panel-title">冒险进度</h3>
      <div class="attr-grid">
        <div class="attr-cell"><span>今日已用</span><b>${st.daily_used} / 5</b></div>
        <div class="attr-cell"><span>当前章节</span><b>第 ${st.chapter} 章</b></div>
        <div class="attr-cell"><span>一章 Boss</span><b>${st.boss_kills_ch1} 次</b></div>
        <div class="attr-cell"><span>二章 Boss</span><b>${st.boss_kills_ch2} 次</b></div>
        <div class="attr-cell"><span>二章解锁</span><b>${st.ch2_unlocked ? '✅ 已解锁' : '❌ 未解锁'}</b></div>
      </div>
    </section>`;
}

function renderSettingsForm(ap) {
  return `
    <div class="settings-form">
      <label class="switch-row"><span>自动使用药水</span><input type="checkbox" id="apEnabled" ${ap.enabled ? 'checked' : ''}></label>
      <label class="field"><span>触发阈值（生命低于 %）</span><input type="number" id="apThreshold" min="1" max="99" value="${ap.threshold}"></label>
      <label class="field"><span>每场最多使用次数</span><input type="number" id="apLimit" min="0" max="10" value="${ap.limit}"></label>
      <button class="primary sm" data-action="save-settings">保存设置</button>
    </div>`;
}

async function saveDungeonSettings() {
  try {
    const d = await api('/api/rpg/dungeon/settings', { method: 'POST', body: {
      enabled: $('#apEnabled').checked,
      threshold: Number($('#apThreshold').value),
      limit: Number($('#apLimit').value)
    }});
    rpg.dungeon = { ...rpg.dungeon, auto_potion: d.auto_potion };
    toast('自动战斗设置已保存');
  } catch (e) { toast(e.message, true); }
}

async function startDungeon() {
  const chapter = Number($('#dungeonChapter').value || 1);
  try {
    const d = await api('/api/rpg/dungeon/start', { method: 'POST', body: { chapter } });
    dungeonSession = { chapter: d.chapter, events: d.events, idx: 0, runGold: 0, baseGold: rpg.gold };
    updateGold();
    toast('副本开始！');
    viewDungeon();
  } catch (e) { toast(e.message, true); }
}

function renderEventTrack(events, idx) {
  return `<div class="dungeon-track">
    ${events.map((ev, i) => {
      const cls = i < idx ? 'done' : (i === idx ? 'current' : 'todo');
      const icon = ev.type === 'fight' ? (ev.tier === 'boss' ? '👑' : (ev.tier === 'elite' ? '💀' : '⚔️')) : '❓';
      const label = i < idx ? '已完成' : (i === idx ? ev.name : '待探索');
      return `<div class="slot-cell ${cls}"><div class="slot-ico">${icon}</div><div class="slot-name">${esc(label)}</div></div>`;
    }).join('')}
  </div>`;
}

// 渲染副本事件推进按钮区：结算 / 继续探索 / 下一事件为奇遇时直接渲染选项
function renderDungeonActions(finish) {
  if (finish) return '<button class="primary" data-action="dungeon-settle">结算副本</button>';
  const next = dungeonSession && dungeonSession.events[dungeonSession.idx];
  if (next && next.type === 'encounter' && next.choices && next.choices.length) {
    return `<div class="event-choices">${next.choices.map((c, i) => `<button class="choice" data-action="dungeon-event" data-choice="${i + 1}">${esc(c)}</button>`).join('')}</div>`;
  }
  return '<button class="primary" data-action="dungeon-event">继续探索</button>';
}

async function dungeonEvent(choice) {
  const body = {};
  if (choice) body.choice = Number(choice);
  try {
    const ev = dungeonSession && dungeonSession.events[dungeonSession.idx];
    if (ev && ev.type === 'encounter' && choice === '') {
      toast('请先选择奇遇选项', true);
      return;
    }
    const d = await api('/api/rpg/dungeon/event', { method: 'POST', body });
    if (d.failed) {
      const runGold = dungeonSession ? (dungeonSession.runGold || 0) : 0;
      rpg.gold = Math.max(0, rpg.gold + runGold - (d.gold_loss || 0));
      dungeonSession = null;
      updateGold();
      $('#view').innerHTML = renderBattleResult(d, true) + `
        <section class="panel glass"><h3 class="panel-title">战败结算</h3><p class="muted">本次副本失败，损失 ${d.gold_loss} 金币（保留经验与普通材料）。</p></section>
        <section class="panel glass"><div class="dungeon-actions">
          <button class="primary" data-action="dungeon-settle">结算副本</button>
        </div></section>`;
      playBattleReplay(d);
      rpg.dungeon = { ...rpg.dungeon, in_dungeon: false };
      return;
    }
    if (d.encounter) {
      dungeonSession.runGold += d.gold || 0;
      updateGold();
      dungeonSession.idx++;
      const finish = d.finished;
      const cur = renderEncounterResult(d);
      $('#view').innerHTML = `
        <div class="page-title"><h2>副本 · 第 ${dungeonSession.chapter} 章</h2><p class="muted">奇遇</p></div>
        <section class="panel glass">${renderEventTrack(dungeonSession.events, dungeonSession.idx)}</section>
        ${cur}
        <section class="panel glass"><div class="dungeon-actions">
          ${renderDungeonActions(finish)}
        </div></section>`;
      return;
    }
    // 战斗
    dungeonSession.runGold += d.gold || 0;
    updateGold();
    dungeonSession.idx++;
    const finish = d.finished;
    $('#view').innerHTML = `
      <div class="page-title"><h2>副本 · 第 ${dungeonSession.chapter} 章</h2><p class="muted">战斗 · ${esc(d.monster)}</p></div>
      <section class="panel glass">${renderEventTrack(dungeonSession.events, dungeonSession.idx)}</section>
      ${renderBattleResult(d, false)}
      <section class="panel glass"><div class="dungeon-actions">
        ${renderDungeonActions(finish)}
      </div></section>`;
    playBattleReplay(d);
    if (d.random_event) { pendingRandomEvent = d.random_event; showRandomEventCard(d.random_event); }
  } catch (e) { toast(e.message, true); }
}

function renderEncounterResult(d) {
  const lines = (d.log || []).map(x => `<li>${esc(x)}</li>`).join('');
  return `<section class="panel glass">
    <h3 class="panel-title">奇遇 · ${esc(d.encounter)}</h3>
    <ul class="battle-log">${lines}</ul>
    <div class="reward-line">
      ${d.gold ? `<span class="r-gold">🪙 +${d.gold}</span>` : ''}
      ${d.hp > 0 ? `<span class="r-hp">❤️ +${d.hp}</span>` : d.hp < 0 ? `<span class="r-hp-dmg">💔 ${d.hp}</span>` : ''}
      ${(d.items || []).map(x => `<span class="r-item">📦 ${esc(x)}</span>`).join('')}
    </div>
  </section>`;
}

function renderBattleResult(d, failed) {
  const lines = (d.log || []).map(x => `<li>${esc(x)}</li>`).join('');
  const drops = (d.drops || []).map(x => `<span class="r-item">📦 ${esc(x.name)}（${QUALITY_CN[x.quality] || x.quality}）</span>`).join('');
  const trace = d.hpTrace && d.hpTrace.length ? d.hpTrace : null;
  const pName = d.playerName || (rpg.char ? `${rpg.char.race}·冒险者` : '冒险者');
  const pEmoji = rpg.char ? (RACE_INFO[rpg.char.race] ? RACE_INFO[rpg.char.race].ico : '🧑') : '🧑';
  const mEmoji = MONSTER_EMOJI[d.monster] || '👾';
  const t0 = trace ? trace[0] : null;
  const pHp = t0 ? t0.p : d.cur_hp, pMax = t0 ? t0.pm : (rpg.char && rpg.char.max_hp) || 100;
  const mHp = t0 ? t0.m : 100, mMax = t0 ? t0.mm : 100;
  const pPct = Math.max(0, Math.round(pHp / Math.max(1, pMax) * 100));
  const mPct = Math.max(0, Math.round(mHp / Math.max(1, mMax) * 100));
  return `<section class="panel glass">
    <h3 class="panel-title">${failed ? '战败' : '战斗胜利'} · ${esc(d.monster)}${d.tier ? `（${d.tier === 'boss' ? 'Boss' : d.tier === 'elite' ? '精英' : '普通'}）` : ''}</h3>
    <div class="battle-stage" id="battleStage">
      <div class="bs-side player">
        <div class="bs-emoji">${pEmoji}</div>
        <div class="bs-name">${esc(pName)}</div>
        <div class="bs-hp"><i style="width:${pPct}%"></i><span>${pHp} / ${pMax}</span></div>
      </div>
      <div class="bs-vs">⚔️</div>
      <div class="bs-side enemy">
        <div class="bs-emoji">${mEmoji}</div>
        <div class="bs-name">${esc(d.monster)}</div>
        <div class="bs-hp"><i style="width:${mPct}%"></i><span>${mHp} / ${mMax}</span></div>
      </div>
    </div>
    <ul class="battle-log replay" id="battleLog"></ul>
    ${failed ? `<div class="reward-line"><span class="r-loss">🪙 -${d.gold_loss} 金币</span></div>` : `
    <div class="reward-line">
      <span class="r-exp">✨ 经验 +${d.exp}</span>
      <span class="r-gold">🪙 +${d.gold}</span>
      ${drops}
    </div>
    ${d.level ? `<p class="muted">等级提升至 Lv.${d.level}！当前生命 ${d.cur_hp}` : ''}`}
  </section>`;
}

// 战斗演出：按 hpTrace 血条回落 + 2 行 2 行逐步跳出（纯展示）
function playBattleReplay(d) {
  const stage = $('#battleStage'); if (!stage) return;
  const logBox = $('#battleLog'); if (!logBox) return;
  const pBar = stage.querySelector('.bs-side.player .bs-hp');
  const mBar = stage.querySelector('.bs-side.enemy .bs-hp');
  const lines = d.log || [];
  const trace = d.hpTrace && d.hpTrace.length ? d.hpTrace : null;
  if (!trace) { logBox.innerHTML = lines.map(x => `<li>${esc(x)}</li>`).join(''); return; }
  const apply = (t) => {
    if (!t) return;
    pBar.querySelector('i').style.width = Math.max(0, Math.round(t.p / Math.max(1, t.pm) * 100)) + '%';
    pBar.querySelector('span').textContent = t.p + ' / ' + t.pm;
    mBar.querySelector('i').style.width = Math.max(0, Math.round(t.m / Math.max(1, t.mm) * 100)) + '%';
    mBar.querySelector('span').textContent = t.m + ' / ' + t.mm;
  };
  apply(trace[0]);
  let ti = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  (async () => {
    for (let i = 0; i < lines.length; i++) {
      await sleep(520);
      const li = document.createElement('li');
      li.textContent = lines[i];
      if (/攻击|造成|撕裂|诅咒|狂暴|流血|破甲|反弹|干扰|削弱|硬化|召唤|恢复|治疗|药水|吸血|反震|护盾|增幅/.test(lines[i])) li.classList.add('hit');
      logBox.appendChild(li);
      if (i % 2 === 1) { ti = Math.min(ti + 1, trace.length - 1); apply(trace[ti]); }
      const shake = [];
      if (/你攻击|你造成|你恢复|你使用/.test(lines[i])) shake.push(mBar);
      if (/敌人攻击|敌人撕裂|敌人反弹|流血造成|敌人施加|敌人干扰|敌人削弱|敌人破甲|你受到|诅咒/.test(lines[i])) shake.push(pBar);
      shake.forEach(el => { el.classList.add('bs-shake'); setTimeout(() => el.classList.remove('bs-shake'), 400); });
    }
    if (ti < trace.length - 1) { ti = trace.length - 1; apply(trace[ti]); }
  })();
}

async function dungeonSettle() {
  try {
    const d = await api('/api/rpg/dungeon/settle', { method: 'POST' });
    const runGold = dungeonSession ? (dungeonSession.runGold || 0) : 0;
    dungeonSession = null;
    rpg.gold += runGold;
    updateGold();
    const battles = (d.battles || []).map(b => `
      <div class="battle-card">
        <div class="battle-head">事件 ${b.event} · ${esc(b.monster)} · ${b.win ? '✅ 胜' : '❌ 败'}</div>
        <ul class="battle-log">${(b.log || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>`).join('');
    const drops = (d.drops || []).map(x => `<span class="r-item">📦 ${esc(x.name)} ×${x.quantity || 1}（${QUALITY_CN[x.quality] || x.quality}）</span>`).join('');
    $('#view').innerHTML = `
      <div class="page-title"><h2>副本结算</h2><p class="muted">第 ${d.chapter} 章</p></div>
      <section class="panel glass">
        <h3 class="panel-title">总览</h3>
        <div class="attr-grid">
          <div class="attr-cell"><span>事件完成</span><b>${d.completed_events} / ${d.total_events}</b></div>
          <div class="attr-cell"><span>Boss</span><b>${d.boss_killed ? '✅ 已击败' : '—'}</b></div>
          <div class="attr-cell"><span>结果</span><b>${d.failed ? '❌ 失败' : '✅ 通关'}</b></div>
          <div class="attr-cell"><span>药水使用</span><b>${d.potions_used} 瓶</b></div>
        </div>
        <div class="reward-line">
          <span class="r-exp">✨ 经验 +${d.exp}</span>
          <span class="r-gold">🪙 +${d.gold}</span>
          ${drops}
        </div>
        ${d.old_map_used ? '<p class="muted">使用了「猎人旧地图」，本局 Boss 出现率提升。</p>' : ''}
      </section>
      <section class="panel glass"><h3 class="panel-title">战斗战报</h3>${battles || '<p class="empty-tip">本局没有战斗记录</p>'}</section>
      <div class="dungeon-actions"><button class="primary" data-action="nav" data-view="dungeon">返回副本</button></div>`;
    if (d.random_event) { pendingRandomEvent = d.random_event; showRandomEventCard(d.random_event); }
    rpg.dungeon = null;
  } catch (e) { toast(e.message, true); }
}

/* ================================================================
 * RPG —— 随机事件（P2）：触发弹卡 / 选择结算
 * ================================================================ */
function showRandomEventCard(ev) {
  if (!ev) return;
  openModal(`
    <div class="event-card">
      <div class="event-ico">✨</div>
      <h3 class="panel-title">随机事件 · ${esc(ev.title)}</h3>
      <p class="muted">${esc(ev.desc)}</p>
      <div class="event-choices">
        ${ev.choices.map((c, i) => `<button class="choice" data-action="rpg-event-choose" data-choice="${i + 1}">${esc(c)}</button>`).join('')}
      </div>
    </div>
  `);
}
async function chooseRandomEvent(choice) {
  const ev = pendingRandomEvent;
  if (!ev) { closeModal(); return; }
  try {
    const d = await api('/api/rpg/events/choose', { method: 'POST', body: { event_id: ev.id, choice } });
    closeModal();
    pendingRandomEvent = null;
    rpg.char = d.character;
    rpg.gold = d.gold;
    rpg.backpack = d.backpack;
    updateGold();
    const parts = [];
    if (d.gold > 0) parts.push(`🪙 +${d.gold} 金币`);
    else if (d.gold < 0) parts.push(`🪙 ${d.gold} 金币`);
    if (d.hp > 0) parts.push(`❤️ +${d.hp} 生命`);
    else if (d.hp < 0) parts.push(`💔 ${d.hp} 生命`);
    (d.items || []).forEach(x => parts.push(`📦 ${x}`));
    (d.log || []).forEach(x => parts.push(x));
    toast(parts.join('，'), false);
    if (rpg.char) rpg.char.cur_hp = d.character.cur_hp;
  } catch (e) { toast(e.message, true); }
}

/* ================================================================
 * RPG —— 铁匠铺页
 * ================================================================ */
async function viewForge() {
  setNav('forge');
  $('#view').innerHTML = '<p class="empty-tip">加载中…</p>';
  try {
    const cat = await api('/api/rpg/forge/catalog');
    rpg.forge = cat;
    rpg.gold = cat.gold;
    updateGold();
    $('#view').innerHTML = `
      <div class="page-title"><h2>铁匠铺</h2><p class="muted">以材料锻造更强装备</p></div>
      <div class="tabs" id="forgeTabs">
        <button data-action="forge-tab" data-tab="material">材料合成</button>
        <button data-action="forge-tab" data-tab="potion">药水制作</button>
        <button data-action="forge-tab" data-tab="equip1">一章装备</button>
        <button data-action="forge-tab" data-tab="equip2">二章装备</button>
      </div>
      <div id="forgeList"></div>`;
    renderForgeList();
  } catch (e) { toast(e.message, true); $('#view').innerHTML = '<p class="empty-tip">加载失败</p>'; }
}

function renderForgeList() {
  $$('#forgeTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === currentForgeTab));
  const cat = rpg.forge;
  if (!cat) return;
  const wrap = $('#forgeList');
  let apiKind = 'material', key = 'material', list = [], title = '材料合成';
  if (currentForgeTab === 'material') { apiKind = 'material'; key = 'material'; list = cat.material || []; title = '材料合成'; }
  else if (currentForgeTab === 'potion') { apiKind = 'potion'; key = 'potion'; list = cat.potion || []; title = '药水制作'; }
  else if (currentForgeTab === 'equip1') { apiKind = 'equip'; key = 'equip_1'; list = cat.equip_1 || []; title = '第一章装备（普通）'; }
  else { apiKind = 'equip'; key = 'equip_2'; list = cat.equip_2 || []; title = '第二章装备（优良）'; }
  if (!list.length) { wrap.innerHTML = '<p class="empty-tip">暂无配方</p>'; return; }
  wrap.innerHTML = `<h3 class="panel-title">${title}</h3><div class="forge-list">
    ${list.map((it, idx) => {
      const ingParts = Object.entries(it.ingredients || {}).map(([m, q]) => {
        const have = it.ownedIngredients ? (it.ownedIngredients[m] || 0) : 0;
        const lack = have < q;
        return `<span class="${lack ? 'forge-miss' : ''}">${esc(m)} ${have}/${q}${lack ? `（缺${q - have}）` : ''}</span>`;
      }).join(' + ');
      const lockMsg = it.unlocked ? '' : '<span class="forge-lock">🔒 未解锁（需通关第一章 Boss）</span>';
      const lackMsg = it.unlocked && it.maxCraftable <= 0 ? '<span class="forge-miss">材料或金币不足</span>' : '';
      const canCraft = it.unlocked && it.maxCraftable > 0 && !forgeBusy;
      return `
      <div class="forge-row glass">
        <div class="forge-name">${esc(it.name)} ${it.quality ? qualityBadge(it.quality) : ''}</div>
        <div class="forge-cost">🪙 ${it.cost}</div>
        <div class="forge-ing">${ingParts}</div>
        ${(lockMsg || lackMsg) ? `<div class="forge-hint">${lockMsg}${lackMsg}</div>` : ''}
        <div class="forge-buy-row">
          <input type="number" class="qty" value="1" min="1" max="${it.maxCraftable || 1}" id="fqty-${key}-${idx}" data-action="forge-qty" data-index="${idx}" ${canCraft ? '' : 'disabled'}>
          <span class="muted">最多 ${it.maxCraftable}</span>
          <button class="primary sm" data-action="forge" data-kind="${apiKind}" data-key="${key}" data-index="${idx}" ${canCraft ? '' : 'disabled'}>制作</button>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function updateForgeQty(index) {
  const cat = rpg.forge;
  if (!cat) return;
  const key = currentForgeTab === 'equip1' ? 'equip_1' : currentForgeTab === 'equip2' ? 'equip_2' : currentForgeTab;
  const it = (cat[key] || [])[index];
  if (!it) return;
  const el = $('#fqty-' + key + '-' + index);
  if (!el) return;
  let v = Math.max(1, Math.min(it.maxCraftable || 1, Number(el.value) || 1));
  el.value = v;
}

async function refreshBackpack() {
  try {
    const d = await api('/api/rpg/backpack');
    rpg.backpack = d.backpack;
  } catch (e) { /* 静默：下次进背包页再拉取 */ }
}

function showForgeResult(d) {
  const stats = d.stats && Object.keys(d.stats).length ? `<div class="item-stats">${statsText(d.stats)}</div>` : '';
  const badge = d.quality ? qualityBadge(d.quality) : '';
  openModal(`
    <h3 class="modal-title">制作成功</h3>
    <div class="modal-body">
      <p>获得 <b>${esc(d.name)}</b> ${badge}${d.quantity ? ' ×' + d.quantity : ''}</p>
      ${stats}
      <p class="muted">消耗 🪙 ${d.cost}${d.cost !== undefined ? '' : ''}</p>
    </div>
    <div class="modal-actions">
      <button class="primary" data-action="close-modal">继续</button>
    </div>`);
}

async function forgeItem(kind, key, index) {
  if (forgeBusy) return;
  const list = (rpg.forge || {})[key] || [];
  const it = list[index];
  if (!it) return;
  const path = kind === 'material' ? '/api/rpg/forge/material' : kind === 'potion' ? '/api/rpg/forge/potion' : '/api/rpg/forge/equip';
  const qtyEl = $('#fqty-' + key + '-' + index);
  const max = it.maxCraftable || 1;
  const quantity = qtyEl ? Math.max(1, Math.min(max, Number(qtyEl.value) || 1)) : 1;
  forgeBusy = true;
  try {
    const d = await api(path, { method: 'POST', body: { recipe: it.name, quantity } });
    rpg.gold = d.gold;
    updateGold();
    refreshBackpack();
    showForgeResult(d);
    const cat = await api('/api/rpg/forge/catalog');
    rpg.forge = cat;
    rpg.gold = cat.gold;
    updateGold();
    renderForgeList();
  } catch (e) { toast(e.message, true); } finally { forgeBusy = false; }
}

/* ================================================================
 * RPG —— 商店页
 * ================================================================ */
async function viewShop() {
  setNav('shop');
  $('#view').innerHTML = '<p class="empty-tip">加载中…</p>';
  try {
    const d = await api('/api/rpg/shop/items');
    rpg.shop = d.items || [];
    rpg.gold = d.gold;
    updateGold();
    $('#view').innerHTML = `
      <div class="page-title"><h2>商店</h2><p class="muted">补给、交易与冒险准备</p></div>
      <div class="tabs" id="shopTabs">
        <button data-action="shop-tab" data-tab="all">全部</button>
        <button data-action="shop-tab" data-tab="consumable">消耗品</button>
        <button data-action="shop-tab" data-tab="material">材料</button>
        <button data-action="shop-tab" data-tab="equip_box">装备箱</button>
      </div>
      <div id="shopList"></div>`;
    renderShopList();
  } catch (e) { toast(e.message, true); $('#view').innerHTML = '<p class="empty-tip">加载失败</p>'; }
}

function renderShopList() {
  $$('#shopTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === currentShopTab));
  const wrap = $('#shopList');
  if (!wrap) return;
  const list = (rpg.shop || []).map((it, i) => ({ ...it, _i: i })).filter(it => currentShopTab === 'all' || it.type === currentShopTab);
  if (!list.length) { wrap.innerHTML = '<p class="empty-tip">暂无商品</p>'; return; }
  wrap.innerHTML = `<div class="shop-grid">
    ${list.map(it => {
      const fixed = it.type === 'equip_box';
      const canBuy = shopBuying || it.maxBuy <= 0 ? false : true;
      return `
      <div class="shop-card glass">
        <div class="shop-ico">${it.type === 'equip_box' ? '🎁' : TYPE_ICO[it.type] || '📦'}</div>
        <div class="shop-name">${esc(it.name)}</div>
        <div class="shop-type muted">${it.category || (it.type === 'equip_box' ? '装备箱' : TYPE_CN[it.type] || it.type)}</div>
        ${it.stats && Object.keys(it.stats).length ? `<div class="shop-stats">${statsText(it.stats)}</div>` : ''}
        <div class="shop-buy-row">
          <input type="number" class="qty" value="1" min="1" max="${fixed ? 1 : it.maxBuy}" id="sqty-${it.type}-${it._i}" data-action="shop-qty" data-index="${it._i}" ${canBuy && !fixed ? '' : 'disabled'}>
          <span class="shop-total muted" id="stotal-${it.type}-${it._i}">共 🪙 ${it.price}</span>
          <button class="primary sm" data-action="shop-buy" data-index="${it._i}" ${canBuy ? '' : 'disabled'}>🪙 ${it.price} 购买</button>
        </div>
        ${it.maxBuy <= 0 && !fixed ? '<div class="forge-hint forge-miss">金币不足</div>' : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function updateShopQty(index) {
  const it = (rpg.shop || [])[index];
  if (!it) return;
  const el = $('#sqty-' + it.type + '-' + index);
  if (!el) return;
  const max = it.type === 'equip_box' ? 1 : (it.maxBuy || 1);
  let v = Math.max(1, Math.min(max, Number(el.value) || 1));
  el.value = v;
  const total = $('#stotal-' + it.type + '-' + index);
  if (total) total.textContent = '共 🪙 ' + (it.price * v);
}

function showShopResult(d) {
  const stats = d.stats && Object.keys(d.stats).length ? `<div class="item-stats">${statsText(d.stats)}</div>` : '';
  const badge = d.quality ? qualityBadge(d.quality) : '';
  openModal(`
    <h3 class="modal-title">购买成功</h3>
    <div class="modal-body">
      <p>获得 <b>${esc(d.name)}</b> ${badge}${d.box ? '' : ' ×' + d.quantity}</p>
      ${stats}
      <p class="muted">花费 🪙 ${d.cost}</p>
    </div>
    <div class="modal-actions">
      <button class="primary" data-action="go-backpack">去背包</button>
      <button class="ghost" data-action="close-modal">继续购物</button>
    </div>`);
}

async function shopBuy(index) {
  if (shopBuying) return;
  const it = (rpg.shop || [])[index];
  if (!it) return;
  const fixed = it.type === 'equip_box';
  const qtyEl = $('#sqty-' + it.type + '-' + index);
  const quantity = fixed ? 1 : (qtyEl ? Math.max(1, Math.min(it.maxBuy || 1, Number(qtyEl.value) || 1)) : 1);
  shopBuying = true;
  try {
    const d = await api('/api/rpg/shop/buy', { method: 'POST', body: { item: it.name, quantity } });
    rpg.gold = d.gold;
    updateGold();
    refreshBackpack();
    showShopResult(d);
    const s = await api('/api/rpg/shop/items');
    rpg.shop = s.items || [];
    rpg.gold = s.gold;
    updateGold();
    renderShopList();
  } catch (e) { toast(e.message, true); } finally { shopBuying = false; }
}

/* ================================================================
 * RPG —— 交易行（P4）
 * ================================================================ */
const MARKET_STATUS_CN = { active: '在售', sold: '已售出', cancelled: '已下架', expired: '已过期' };
async function viewMarket() {
  setNav('market');
  $('#view').innerHTML = '<p class="empty-tip">加载中…</p>';
  try {
    const b = await api('/api/rpg/backpack');
    rpg.backpack = b.backpack;
    rpg.gold = b.gold;
    updateGold();
    const mine = await api('/api/rpg/market/mine');
    rpg.market = { listings: null, mine: mine.orders || [], total: 0, fee_rate: mine.fee_rate || 0.05 };
    $('#view').innerHTML = `
      <div class="page-title"><h2>交易行</h2><p class="muted">装备与材料自由交易 · 手续费 ${Math.round((rpg.market.fee_rate || 0.05) * 100)}% · 挂单保留 48 小时</p></div>
      <div class="tabs" id="marketTabs">
        <button data-action="market-tab" data-tab="all">在售列表</button>
        <button data-action="market-tab" data-tab="mine">我的挂单</button>
      </div>
      <div id="marketList"></div>`;
    currentMarketTab = 'all';
    marketPage = 1;
    renderMarketAll();
  } catch (e) { toast(e.message, true); $('#view').innerHTML = '<p class="empty-tip">加载失败</p>'; }
}
function renderMarketAll() {
  if (currentMarketTab === 'mine') renderMarketMine();
  else renderMarketList();
}
async function renderMarketList() {
  $$('#marketTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'all'));
  const wrap = $('#marketList');
  if (!wrap) return;
  const type = $('#mfilter-type')?.value || '';
  const quality = $('#mfilter-quality')?.value || '';
  const sort = $('#mfilter-sort')?.value || 'newest';
  try {
    const q = new URLSearchParams({ page: marketPage, page_size: 20, type, quality, sort });
    const d = await api('/api/rpg/market/listings?' + q.toString());
    rpg.market.listings = d;
    rpg.gold = d.gold !== undefined ? d.gold : rpg.gold;
    updateGold();
    const totalPages = Math.max(1, Math.ceil(d.total / d.page_size));
    wrap.innerHTML = `
      <div class="market-toolbar">
        <select id="mfilter-type" data-action="market-filter">
          <option value="">全部类型</option>
          <option value="weapon" ${type === 'weapon' ? 'selected' : ''}>武器</option>
          <option value="armor" ${type === 'armor' ? 'selected' : ''}>护甲</option>
          <option value="accessory" ${type === 'accessory' ? 'selected' : ''}>饰品</option>
          <option value="material" ${type === 'material' ? 'selected' : ''}>材料</option>
        </select>
        <select id="mfilter-quality" data-action="market-filter">
          <option value="">全部品质</option>
          <option value="normal" ${quality === 'normal' ? 'selected' : ''}>普通</option>
          <option value="fine" ${quality === 'fine' ? 'selected' : ''}>优良</option>
          <option value="superb" ${quality === 'superb' ? 'selected' : ''}>精良</option>
          <option value="rare" ${quality === 'rare' ? 'selected' : ''}>稀有</option>
          <option value="legendary" ${quality === 'legendary' ? 'selected' : ''}>传说</option>
        </select>
        <select id="mfilter-sort" data-action="market-filter">
          <option value="newest" ${sort === 'newest' ? 'selected' : ''}>最新上架</option>
          <option value="price_asc" ${sort === 'price_asc' ? 'selected' : ''}>价格从低到高</option>
          <option value="price_desc" ${sort === 'price_desc' ? 'selected' : ''}>价格从高到低</option>
        </select>
        <button class="primary sm" data-action="market-sell">+ 上架物品</button>
      </div>
      <div class="shop-grid">
        ${(d.orders || []).map(o => {
          const mine = o.seller_id === ME.id;
          const stats = o.item_stats && Object.keys(o.item_stats).length ? `<div class="item-stats">${statsText(o.item_stats)}</div>` : '';
          return `
          <div class="shop-card glass">
            <div class="shop-ico">${TYPE_ICO[o.item_type] || '📦'}</div>
            <div class="shop-name">${esc(o.item_name)} ${qualityBadge(o.item_quality)}${mine ? ' <span class="q-badge q-rare">我的</span>' : ''}</div>
            <div class="shop-type muted">${TYPE_CN[o.item_type] || o.item_type}${o.quantity > 1 ? ' ×' + o.quantity : ''} · ${esc(o.seller_name)}</div>
            ${stats}
            <div class="shop-buy-row">
              <span class="shop-total muted">🪙 ${o.price}</span>
              ${mine
                ? `<button class="ghost sm" data-action="market-cancel" data-id="${o.id}">下架</button>`
                : `<button class="primary sm" data-action="market-buy" data-id="${o.id}">购买</button>`}
            </div>
          </div>`;
        }).join('') || '<p class="empty-tip">暂无在售物品</p>'}
      </div>
      ${totalPages > 1 ? `
      <div class="market-pager">
        <button class="ghost sm" data-action="market-page" data-page="${marketPage - 1}" ${marketPage <= 1 ? 'disabled' : ''}>上一页</button>
        <span class="muted">第 ${marketPage} / ${totalPages} 页</span>
        <button class="ghost sm" data-action="market-page" data-page="${marketPage + 1}" ${marketPage >= totalPages ? 'disabled' : ''}>下一页</button>
      </div>` : ''}`;
  } catch (e) { toast(e.message, true); wrap.innerHTML = '<p class="empty-tip">加载失败</p>'; }
}
async function renderMarketMine() {
  $$('#marketTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'mine'));
  const wrap = $('#marketList');
  if (!wrap) return;
  try {
    const d = await api('/api/rpg/market/mine');
    rpg.market.mine = d.orders || [];
    const active = (d.orders || []).filter(o => o.status === 'active');
    wrap.innerHTML = `
      <div class="market-toolbar">
        <span class="muted">在售 ${active.length} 笔 · 全部 ${(d.orders || []).length} 笔</span>
        <button class="primary sm" data-action="market-sell">+ 上架物品</button>
      </div>
      <div class="shop-grid">
        ${active.map(o => {
          const stats = o.item_stats && Object.keys(o.item_stats).length ? `<div class="item-stats">${statsText(o.item_stats)}</div>` : '';
          return `
          <div class="shop-card glass">
            <div class="shop-ico">${TYPE_ICO[o.item_type] || '📦'}</div>
            <div class="shop-name">${esc(o.item_name)} ${qualityBadge(o.item_quality)}</div>
            <div class="shop-type muted">${TYPE_CN[o.item_type] || o.item_type}${o.quantity > 1 ? ' ×' + o.quantity : ''} · 在售</div>
            ${stats}
            <div class="shop-buy-row">
              <span class="shop-total muted">🪙 ${o.price}</span>
              <button class="ghost sm" data-action="market-cancel" data-id="${o.id}">下架</button>
            </div>
          </div>`;
        }).join('') || '<p class="empty-tip">暂无在售挂单，点击“上架物品”出售背包中的装备或材料</p>'}
      </div>
      <h3 class="panel-title" style="margin-top:16px">历史记录</h3>
      <div class="stack-list">
        ${(d.orders || []).filter(o => o.status !== 'active').map(o => `
          <div class="stack-row glass">
            <span class="stack-ico">${TYPE_ICO[o.item_type] || '📦'}</span>
            <span class="muted">${esc(o.item_name)} ×${o.quantity} · 🪙 ${o.price} · ${MARKET_STATUS_CN[o.status] || o.status}</span>
          </div>`).join('') || '<p class="empty-tip">暂无历史记录</p>'}
      </div>`;
  } catch (e) { toast(e.message, true); wrap.innerHTML = '<p class="empty-tip">加载失败</p>'; }
}
let marketSellItems = []; // 上架候选：背包可交易物品
let marketSellSel = -1; // 上架弹窗选中的候选下标
async function openMarketSell() {
  try {
    const b = await api('/api/rpg/backpack');
    marketSellItems = ((b.backpack && b.backpack.equipment) || []).map(it => ({ ...it, sellQty: 1 }))
      .concat(((b.backpack && b.backpack.material) || []).map(it => ({ ...it, sellQty: 1 })));
    marketSellSel = -1;
    if (!marketSellItems.length) { toast('背包中没有可交易的装备或材料', true); return; }
    renderMarketSellModal();
  } catch (e) { toast(e.message, true); }
}
function renderMarketSellModal() {
  openModal(`
    <h3 class="modal-title">上架物品</h3>
    <div class="modal-body">
      <div class="sell-cands">
        ${marketSellItems.map((it, idx) => `
          <div class="sell-cand ${marketSellSel === idx ? 'selected' : ''}" data-action="market-sell-item" data-index="${idx}">
            <span class="stack-ico">${TYPE_ICO[it.type] || '📦'}</span>
            <span>${esc(it.name)} ${qualityBadge(it.quality)}</span>
            <span class="muted">×${it.quantity}${it.type === 'material' ? '（可上架部分）' : ''}</span>
          </div>`).join('')}
      </div>
      ${marketSellSel >= 0 ? `
      <div class="sell-form">
        <label class="field"><span>数量</span>
          <input type="number" id="sellQty" value="${marketSellItems[marketSellSel].sellQty}" min="1" max="${marketSellItems[marketSellSel].quantity}" ${marketSellItems[marketSellSel].type === 'material' ? '' : 'disabled'}>
        </label>
        <label class="field"><span>单价（金币）</span>
          <input type="number" id="sellPrice" value="100" min="1" max="500000">
        </label>
        <p class="muted">成交后收取 5% 手续费，卖家实得 95%</p>
      </div>` : '<p class="muted">请选择要出售的物品</p>'}
    </div>
    <div class="modal-actions">
      <button class="primary" data-action="market-sell-submit" ${marketSellSel < 0 ? 'disabled' : ''}>确认上架</button>
      <button class="ghost" data-action="close-modal">取消</button>
    </div>`);
  if (marketSellSel >= 0) {
    const it = marketSellItems[marketSellSel];
    const q = $('#sellQty');
    if (q) q.addEventListener('input', () => { it.sellQty = Math.max(1, Math.min(it.quantity, Number(q.value) || 1)); q.value = it.sellQty; });
  }
}
function selectMarketSellItem(idx) {
  marketSellSel = idx;
  renderMarketSellModal();
}
async function submitMarketSell() {
  if (marketBusy) return;
  if (marketSellSel < 0) return;
  const it = marketSellItems[marketSellSel];
  const price = Number($('#sellPrice')?.value || 0);
  if (!price || price < 1 || price > 500000) { toast('价格须在 1-500000 之间', true); return; }
  const quantity = it.type === 'material' ? it.sellQty || 1 : 1;
  marketBusy = true;
  try {
    const d = await api('/api/rpg/market/create', { method: 'POST', body: { item_id: it.id, price, quantity } });
    closeModal();
    toast(`已上架 ${d.item_name}${d.quantity > 1 ? ' ×' + d.quantity : ''}，定价 🪙 ${d.price}`);
    const b = await api('/api/rpg/backpack');
    rpg.backpack = b.backpack;
    rpg.gold = b.gold;
    updateGold();
    renderMarketAll();
  } catch (e) { toast(e.message, true); } finally { marketBusy = false; }
}
async function marketBuy(id) {
  if (marketBusy) return;
  marketBusy = true;
  try {
    const d = await api('/api/rpg/market/buy', { method: 'POST', body: { order_id: id } });
    rpg.gold = d.gold;
    updateGold();
    refreshBackpack();
    toast(`购买成功：${d.name} ×${d.quantity}，花费 🪙 ${d.cost}（含手续费 🪙 ${d.fee}）`);
    renderMarketAll();
  } catch (e) { toast(e.message, true); } finally { marketBusy = false; }
}
async function marketCancel(id) {
  if (marketBusy) return;
  marketBusy = true;
  try {
    await api('/api/rpg/market/cancel', { method: 'POST', body: { order_id: id } });
    toast('已下架，物品已归还背包');
    refreshBackpack();
    renderMarketAll();
  } catch (e) { toast(e.message, true); } finally { marketBusy = false; }
}

/* ================================================================
 * 会话 / 启动
 * ================================================================ */
function updateGold() {
  const p = $('#goldPill');
  if (!p) return;
  const run = dungeonSession ? (dungeonSession.runGold || 0) : 0;
  p.innerHTML = `🪙 <b>${rpg.gold ?? 0}</b> 金币${run > 0 ? `<span class="run-gold"> · 本次 +${run}</span>` : ''}`;
}

function renderShellUser() {
  renderSideAccount();
}

function showAuth() {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  ME = null;
  rpg = { char: null, gold: 0, backpack: null, dungeon: null, forge: null, shop: null };
  dungeonSession = null;
  $('#shell').classList.add('hidden');
  $('#authView').classList.remove('hidden');
  renderAuth();
}

async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  showAuth();
  toast('已退出登录');
}

function enterShell() {
  $('#authView').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  renderShellUser();
  viewCharacter();
  connectChat();
}

function bindShell() {
  $('#logoutBtn').onclick = logout;
  $('#menuBtn').onclick = () => {
    $('.sidebar').classList.add('open');
    $('#sideMask').classList.add('open');
  };
  $('#sideMask').onclick = () => {
    $('.sidebar').classList.remove('open');
    $('#sideMask').classList.remove('open');
  };
  // 窗口大小变化时聊天室默认状态
  const mq = window.matchMedia('(min-width: 1025px)');
  mq.addEventListener('change', e => {
    if (e.matches) setChatOpen(true);
    else setChatOpen(false);
  });
}

function boot() {
  const navDefs = [
    ['character', '⚔️', '角色'], ['backpack', '🎒', '背包'], ['dungeon', '🗺️', '副本'],
    ['forge', '🔨', '铁匠铺'], ['shop', '🛒', '商店'], ['market', '🏪', '交易行']
  ];
  const bn = $('#bottomNav');
  if (bn && !bn.children.length) {
    bn.innerHTML = navDefs.map(([v, ic, t]) => `<button data-view="${v}" data-action="nav"><span class="nav-ico">${ic}</span>${t}</button>`).join('');
  }
  renderAuth();
  bindShell();
  bindChat();
  api('/api/me').then(d => {
    if (!d || !d.user) { showAuth(); return; }
    ME = d.user;
    enterShell();
  }).catch(() => {
    showAuth();
  });
}

document.addEventListener('DOMContentLoaded', boot);
