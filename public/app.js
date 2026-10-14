/* Campfire Arcade 前端逻辑 —— 无内联事件处理器，全部 addEventListener + 事件委托 */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let me = null;
let ws = null;
let onlineCount = 0;
let currentFilter = '全部';
let currentSort = 'latest';
let currentSearch = '';

const CAT_EMOJI = {
  '游戏讨论':'🎮','心得分享':'📖','求助提问':'❓','独立游戏':'🎲','趣味闲聊':'🔥',
  '玩家创作':'🎨','资源分享':'📦','日常闲聊':'☕','默认':'✦'
};
const CATEGORIES = ['游戏讨论','心得分享','求助提问','独立游戏','趣味闲聊','玩家创作','资源分享'];
const FILTERS = ['全部','游戏讨论','心得分享','求助提问','独立游戏','趣味闲聊'];
const EMOJIS = ['😀','😄','😂','🤣','😊','😍','🤔','😎','🥳','😭','😅','🙃','👍','👏','🔥','❤️','💯','🎉','🍻','🌙','⛺','🎮','✨'];

/* ---------- 通用工具 ---------- */
function toast(msg, isErr = false){
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.style.display = 'none', 2600);
}
async function api(path, opt = {}){
  const r = await fetch(path, {headers:{'Content-Type':'application/json', ...(opt.headers||{})}, ...opt});
  let d;
  try { d = await r.json(); } catch { d = {}; }
  if(!r.ok) throw new Error(d.error || '请求失败');
  return d;
}
function avatarDataUri(name, size = 40){
  const colors = ['#f59e0b','#79e1c2','#f472b6','#a78bfa','#60a5fa','#fb923c','#34d399','#f87171','#38bdf8','#c084fc'];
  let h = 0;
  const s = String(name||'?');
  for(const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const color = colors[h % colors.length];
  const ch = (s[0] || '?').toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'><rect width='${size}' height='${size}' rx='${Math.round(size*0.25)}' fill='${color}'/><text x='${size/2}' y='${size*0.68}' font-size='${Math.round(size*0.46)}' text-anchor='middle' fill='#fff' font-family='sans-serif' font-weight='bold'>${ch}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
function catEmoji(c){ return CAT_EMOJI[c] || CAT_EMOJI['默认']; }
function fmtTime(ts){
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if(diff < 60*1000) return '刚刚';
  if(diff < 3600*1000) return Math.floor(diff/60000) + ' 分钟前';
  if(diff < 86400*1000) return Math.floor(diff/3600000) + ' 小时前';
  if(diff < 7*86400*1000) return Math.floor(diff/86400000) + ' 天前';
  return d.toLocaleDateString();
}
function avatarImg(name, cls){
  return `<img class="avatar ${cls||''}" src="${avatarDataUri(name)}" alt="${esc(name)}">`;
}

/* ---------- 启动 ---------- */
async function boot(){
  try {
    const d = await api('/api/me');
    me = d.user;
    if(!me){ showAuth('login'); return; }
    enterShell();
  } catch(e){ toast(e.message, true); }
}

/* ---------- 登录 / 注册 ---------- */
function showAuth(mode){
  $('#authView').classList.remove('hidden');
  $('#shell').classList.add('hidden');
  renderAuth(mode);
}
function renderAuth(mode){
  const card = $('#authCard');
  if(mode === 'login'){
    card.innerHTML = `
      <div class="auth-brand"><span class="mark">✦</span> Campfire Arcade</div>
      <h2 class="auth-hello">欢迎回来<span class="hl">。</span></h2>
      <p class="auth-desc">这是一个仅限受邀好友加入的私密论坛，在这里分享生活、交流想法，记录我们的小小世界。</p>
      <div class="field"><label>账号</label><div class="in-wrap"><span class="in-ico">👤</span><input id="authU" autocomplete="username" placeholder="输入账号"></div></div>
      <div class="field"><label>密码</label><div class="in-wrap"><span class="in-ico">🔒</span><input id="authP" type="password" autocomplete="current-password" placeholder="输入密码"><button class="pw-toggle" id="pwToggle" type="button" data-pw="authP">👁</button></div></div>
      <div class="auth-actions">
        <button class="primary" id="doLogin">登录</button>
        <button class="ghost" id="toRegister">使用邀请码注册</button>
      </div>
      <p class="auth-tip">邀请码由管理员创建，为临时有效，仅限受邀的朋友使用，请妥善保管并及时注册。</p>`;
    $('#doLogin').addEventListener('click', doLogin);
    $('#toRegister').addEventListener('click', () => renderAuth('register'));
  } else {
    card.innerHTML = `
      <div class="auth-brand"><span class="mark">✦</span> Campfire Arcade</div>
      <h2 class="auth-hello">加入篝火<span class="hl">。</span></h2>
      <p class="auth-desc">带上你的邀请码，成为这个小社区的一员——发帖、聊天，分享你的游戏与故事。</p>
      <div class="field"><label>账号</label><div class="in-wrap"><span class="in-ico">👤</span><input id="authU" autocomplete="username" placeholder="3–24 位字母、数字或下划线"></div></div>
      <div class="field"><label>密码</label><div class="in-wrap"><span class="in-ico">🔒</span><input id="authP" type="password" autocomplete="new-password" placeholder="至少 10 位"><button class="pw-toggle" id="pwToggle" type="button" data-pw="authP">👁</button></div></div>
      <div class="field"><label>限时邀请码</label><div class="in-wrap"><span class="in-ico">🗝️</span><input id="authI" placeholder="请输入邀请码"></div></div>
      <div class="auth-actions">
        <button class="primary" id="doReg">注册并登录</button>
        <button class="ghost" id="toLogin">返回登录</button>
      </div>
      <p class="auth-tip">邀请码由管理员创建，为临时有效，仅限受邀的朋友使用，请妥善保管并及时注册。</p>`;
    $('#doReg').addEventListener('click', doRegister);
    $('#toLogin').addEventListener('click', () => renderAuth('login'));
  }
  bindPwToggle();
}
function bindPwToggle(){
  const btn = $('#pwToggle');
  if(btn) btn.addEventListener('click', () => {
    const inp = $('#' + btn.dataset.pw);
    inp.type = inp.type === 'password' ? 'text' : 'password';
    btn.textContent = inp.type === 'password' ? '👁' : '🙈';
  });
}
async function doLogin(){
  try {
    await api('/api/login', {method:'POST', body:JSON.stringify({username:$('#authU').value, password:$('#authP').value})});
    location.reload();
  } catch(e){ toast(e.message, true); }
}
async function doRegister(){
  try {
    await api('/api/register', {method:'POST', body:JSON.stringify({username:$('#authU').value, password:$('#authP').value, invite:$('#authI').value})});
    location.reload();
  } catch(e){ toast(e.message, true); }
}

/* ---------- 进入主界面 ---------- */
function enterShell(){
  $('#authView').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  renderSideAccount();
  bindNav();
  bindChat();
  refreshNotifBadge();
  viewHome();
}
function renderSideAccount(){
  $('#sideAccount').innerHTML = `
    <div class="who">${avatarImg(me.username)}<div><b>${esc(me.username)}</b><span>${me.role==='admin'?'管理员':'成员'} · 篝火旁</span></div></div>`;
  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('/api/logout', {method:'POST'}); } catch {}
    location.reload();
  });
}
function setNav(view){
  $$('#sideNav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}
function bindNav(){
  $$('#sideNav button').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.view;
    setNav(v);
    if(v==='home') viewHome();
    else if(v==='topics') viewTopics();
    else if(v==='games') viewGames();
    else if(v==='creations') viewCreations();
    else if(v==='events') viewEvents();
    else if(v==='resources') viewResources();
    else if(v==='favorites') viewFavorites();
    else if(v==='notifications') viewNotifications();
    else if(v==='profile') viewProfile();
  }));
  $('#newTopicBtn').addEventListener('click', openNewTopic);
  $('#searchInput').addEventListener('keydown', e => { if(e.key==='Enter'){ currentSearch = e.target.value.trim(); viewTopics(); } });
}

/* ---------- 帖子列表 ---------- */
function postCard(t){
  return `<article class="post-card" data-action="open-topic" data-id="${t.id}">
    <div class="post-thumb">${catEmoji(t.category)}</div>
    <div class="post-body">
      <h3 class="post-title">${esc(t.title)}</h3>
      <p class="post-excerpt">${esc(t.body)}</p>
      <div class="post-foot">
        <span class="pill">${esc(t.category)}</span>
        <span class="poster">${avatarImg(t.username)} ${esc(t.username)}</span>
        <span class="meta">${fmtTime(t.created)}</span>
        <span class="stats">
          <span class="stat"><span class="heart">❤</span><b>${t.likes||0}</b></span>
          <span class="stat"><span class="fire">🔥</span><b>${t.replies||0}</b></span>
        </span>
      </div>
    </div>
  </article>`;
}
function filterBar(){
  return `<div class="filter-bar">
    <div class="filter-tags">
      ${FILTERS.map(f => `<button class="tag-btn ${f===currentFilter?'active':''}" data-action="filter" data-filter="${f}">${f}</button>`).join('')}
    </div>
    <select class="sort-select" id="sortSelect">
      <option value="latest" ${currentSort==='latest'?'selected':''}>最新发布</option>
      <option value="replies" ${currentSort==='replies'?'selected':''}>最新回复</option>
      <option value="likes" ${currentSort==='likes'?'selected':''}>最热点赞</option>
    </select>
  </div>`;
}
async function loadTopics(params = ''){
  let qs = `sort=${currentSort}`;
  if(currentFilter !== '全部') qs += `&category=${encodeURIComponent(currentFilter)}`;
  if(currentSearch) qs += `&q=${encodeURIComponent(currentSearch)}`;
  if(params) qs += params;
  return api('/api/topics?' + qs);
}
async function viewTopics(){
  const data = await loadTopics();
  $('#view').innerHTML = `
    <div class="filter-bar">${filterBar()}</div>
    ${currentSearch ? `<p class="meta">搜索“${esc(currentSearch)}”的结果（${data.topics.length} 条）</p>` : ''}
    <div class="post-list" id="postList">${data.topics.map(postCard).join('') || '<p class="empty-tip">还没有帖子，来发第一个吧。</p>'}</div>`;
  $('#sortSelect').addEventListener('change', e => { currentSort = e.target.value; viewTopics(); });
}
async function viewHome(){
  setNav('home');
  const data = await loadTopics('&limit=10');
  $('#view').innerHTML = `
    <div class="filter-bar">
      <div class="filter-tags">${FILTERS.map(f => `<button class="tag-btn ${f===currentFilter?'active':''}" data-action="filter" data-filter="${f}">${f}</button>`).join('')}</div>
    </div>
    <div class="post-list">${data.topics.map(postCard).join('') || '<p class="empty-tip">还没有帖子，来发第一个吧。</p>'}</div>`;
}
async function viewCreations(){
  currentFilter = '玩家创作';
  setNav('creations');
  const data = await loadTopics();
  $('#view').innerHTML = `<h2 class="view-title">🎨 玩家创作</h2>
    <div class="post-list">${data.topics.map(postCard).join('') || '<p class="empty-tip">还没有玩家创作，快去分享吧。</p>'}</div>`;
}
async function viewResources(){
  currentFilter = '资源分享';
  setNav('resources');
  const data = await loadTopics();
  $('#view').innerHTML = `<h2 class="view-title">📦 资源分享</h2>
    <div class="post-list">${data.topics.map(postCard).join('') || '<p class="empty-tip">还没有资源分享。</p>'}</div>`;
}

/* ---------- 话题详情 ---------- */
async function openTopic(id){
  const t = await api('/api/topics/' + id);
  $('#view').innerHTML = `
    <div class="panel topic-detail">
      <div class="row"><button class="ghost" data-action="go-topics">← 返回</button></div>
      <h1>${catEmoji(t.category)} ${esc(t.title)}</h1>
      <div class="meta">${avatarImg(t.username)} ${esc(t.username)} · ${new Date(t.created).toLocaleString()} · <span class="pill">${esc(t.category)}</span></div>
      <p class="pre-wrap">${esc(t.body)}</p>
      <div class="actions-bar">
        <button class="ghost like-btn ${t.liked?'liked':''}" data-action="like" data-id="${t.id}">❤ ${t.likes}</button>
        <button class="ghost fav-btn ${t.faved?'faved':''}" data-action="fav" data-id="${t.id}">⭐ ${t.faved?'已收藏':'收藏'}</button>
      </div>
      <hr class="divider">
      <h3>💬 回复（${t.replies.length}）</h3>
      <div id="replyList">${t.replies.map(r => `
        <div class="reply-item">
          <div class="rhead">${avatarImg(r.username)} <b>${esc(r.username)}</b> <span class="meta">${new Date(r.created).toLocaleString()}</span></div>
          <div class="pre-wrap">${esc(r.body)}</div>
        </div>`).join('') || '<p class="meta">还没有回复。</p>'}</div>
      <div class="field"><label>写下回复…</label><textarea id="replyBody" rows="3"></textarea></div>
      <div class="form-actions"><button class="primary" id="sendReply">发送回复</button></div>
    </div>`;
  $('#sendReply').addEventListener('click', async () => {
    try {
      await api('/api/topics/' + id + '/replies', {method:'POST', body:JSON.stringify({body:$('#replyBody').value})});
      openTopic(id);
    } catch(e){ toast(e.message, true); }
  });
}

/* ---------- 发起话题 ---------- */
function openNewTopic(){
  openModal(`
    <h2>✎ 发起话题</h2>
    <p class="meta">分享你的游戏、故事或问题。</p>
    <div class="field"><label>标题</label><input id="ntTitle" maxlength="100" placeholder="一句话说清楚"></div>
    <div class="field"><label>分类</label><select id="ntCat"><option>游戏讨论</option><option>心得分享</option><option>求助提问</option><option>独立游戏</option><option>趣味闲聊</option><option>玩家创作</option><option>资源分享</option></select></div>
    <div class="field"><label>内容</label><textarea id="ntBody" rows="7" placeholder="写点什么…"></textarea></div>
    <div class="form-actions"><button class="primary" id="ntSubmit">发布</button><button class="ghost" data-action="close-modal">取消</button></div>`, 'newTopic');
  $('#ntSubmit').addEventListener('click', async () => {
    try {
      await api('/api/topics', {method:'POST', body:JSON.stringify({title:$('#ntTitle').value, category:$('#ntCat').value, body:$('#ntBody').value})});
      closeModal();
      toast('话题已发布');
      viewHome();
    } catch(e){ toast(e.message, true); }
  });
}

/* ---------- 游戏 / 活动 / 收藏 / 通知 / 个人资料 ---------- */
async function viewGames(){
  setNav('games');
  const gs = await api('/api/games');
  $('#view').innerHTML = `<h2 class="view-title">🎮 发现游戏</h2>
    <div class="cards-grid">${gs.map(g => `
      <article class="game-card"><div class="game-ico">🎮</div><h3>${esc(g.title)}</h3><p>${esc(g.description)}</p><a class="primary" href="${esc(g.url)}" target="_blank" rel="noopener">开始游戏</a></article>`).join('') || '<p class="empty-tip">管理员还没有添加游戏。</p>'}</div>`;
}
async function viewEvents(){
  setNav('events');
  const evs = await api('/api/events');
  $('#view').innerHTML = `<div class="row" class="row spread">
      <h2 class="no-margin">📅 活动日历</h2>
      <button class="primary" id="newEventBtn">＋ 发起活动</button></div>
    <div class="event-list">${evs.map(ev => `
      <article class="event-card">
        <div class="event-date"><span class="day">${new Date(ev.start_time).getDate()}</span>${new Date(ev.start_time).toLocaleDateString('zh-CN',{month:'long'})}</div>
        <h3>${esc(ev.title)}</h3>
        <p>${esc(ev.description||'')}</p>
        <div class="meta">⏰ ${new Date(ev.start_time).toLocaleString()} · 主办 ${esc(ev.creator_name)}</div>
        <div class="row"><button class="mini-btn ${ev.joined?'':'hidden'}" data-action="event-join" data-id="${ev.id}">✔ 已参加</button>
        <button class="mini-btn ${ev.joined?'hidden':''}" data-action="event-join" data-id="${ev.id}">我要参加</button>
        <span class="meta">${ev.participants} 人参加</span></div>
      </article>`).join('') || '<p class="empty-tip">还没有活动。</p>'}</div>`;
  $('#newEventBtn').addEventListener('click', openNewEvent);
}
function openNewEvent(){
  openModal(`
    <h2>＋ 发起活动</h2>
    <div class="field"><label>活动名称</label><input id="evTitle" placeholder="例如：周末游戏之夜"></div>
    <div class="field"><label>开始时间</label><input id="evTime" type="datetime-local"></div>
    <div class="field"><label>活动介绍</label><textarea id="evDesc" rows="4" placeholder="说明活动内容…"></textarea></div>
    <div class="form-actions"><button class="primary" id="evSubmit">发布活动</button><button class="ghost" data-action="close-modal">取消</button></div>`, 'newEvent');
  $('#evSubmit').addEventListener('click', async () => {
    try {
      const t = $('#evTime').value;
      await api('/api/events', {method:'POST', body:JSON.stringify({title:$('#evTitle').value, start_time:t ? new Date(t).getTime() : Date.now()+86400000, description:$('#evDesc').value})});
      closeModal();
      toast('活动已发布');
      viewEvents();
    } catch(e){ toast(e.message, true); }
  });
}
async function viewFavorites(){
  setNav('favorites');
  const data = await api('/api/favorites');
  $('#view').innerHTML = `<h2 class="view-title">⭐ 我的收藏</h2>
    <div class="post-list">${data.topics.map(postCard).join('') || '<p class="empty-tip">还没有收藏任何帖子。</p>'}</div>`;
}
async function viewNotifications(){
  setNav('notifications');
  const ns = await api('/api/notifications');
  $('#view').innerHTML = `<div class="row" class="row spread">
      <h2 class="no-margin">🔔 消息通知</h2>
      ${ns.some(n=>!n.read) ? '<button class="ghost" id="readAllBtn">全部标为已读</button>' : ''}</div>
    ${ns.map(n => `
      <div class="notif-item ${n.read?'':'unread'}">
        <span class="n-ico">${n.type==='reply'?'💬':'📅'}</span>
        <div><p>${esc(n.body)}</p><span class="meta">${fmtTime(n.created)}</span></div>
      </div>`).join('') || '<p class="empty-tip">暂无通知。</p>'}`;
  const b = $('#readAllBtn');
  if(b) b.addEventListener('click', async () => { await api('/api/notifications/read', {method:'POST'}); refreshNotifBadge(); viewNotifications(); });
}
async function viewProfile(){
  setNav('profile');
  const st = await api('/api/my/stats');
  const my = await api('/api/my/topics');
  $('#view').innerHTML = `
    <div class="panel">
      <div class="profile-head">${avatarImg(me.username, 'lg')}
        <div><h2 class="no-margin">${esc(me.username)}</h2>
        <span class="pill ${me.role==='admin'?'':'mint'}">${me.role==='admin'?'管理员':'成员'}</span>
        <span class="pill muted">${new Date(st.created).toLocaleDateString()} 加入</span>
        <div class="profile-num">
          <div class="pn"><b>${st.topics}</b><span>话题</span></div>
          <div class="pn"><b>${st.replies}</b><span>回复</span></div>
          <div class="pn"><b>${st.likes_given}</b><span>获赞</span></div>
          <div class="pn"><b>${st.favorites}</b><span>收藏</span></div>
        </div></div>
      </div>
    </div>
    <h3 class="section-title">我发起的话题</h3>
    <div class="post-list">${my.topics.map(postCard).join('') || '<p class="empty-tip">还没有发起过话题。</p>'}</div>`;
}

/* ---------- 通知角标 ---------- */
async function refreshNotifBadge(){
  try {
    const d = await api('/api/notifications');
    const n = d.unread || 0;
    const b = $('#notifBadge');
    b.textContent = n > 99 ? '99+' : n;
    b.classList.toggle('hidden', n === 0);
  } catch {}
}

/* ---------- 聊天室 ---------- */
function bindChat(){
  const input = $('#chatInput');
  const sendBtn = $('#chatSend');
  const emojiBtn = $('#emojiBtn');
  sendBtn.addEventListener('click', sendChat);
  input.addEventListener('keydown', e => { if(e.key === 'Enter') sendChat(); });
  emojiBtn.addEventListener('click', () => {
    const pop = $('#emojiPop');
    if(pop.classList.contains('hidden')){
      pop.innerHTML = EMOJIS.map(e => `<button data-action="emoji" data-e="${e}">${e}</button>`).join('');
      pop.classList.remove('hidden');
    } else pop.classList.add('hidden');
  });
  $('#eventJoinBtn').addEventListener('click', async () => {
    try {
      await api('/api/events/' + currentEventId + '/join', {method:'POST'});
      toast('已报名活动');
      refreshEventCard();
    } catch(e){ toast(e.message, true); }
  });
}
let currentEventId = 0;
function sendChat(){
  const input = $('#chatInput');
  const v = (input.value || '').trim();
  if(!v) return;
  if(!ws || ws.readyState !== 1){ toast('连接未就绪，请稍后再试', true); return; }
  ws.send(JSON.stringify({body: v}));
  input.value = '';
}
function connectChat(){
  if(ws){ try{ ws.close(); }catch{} }
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => {};
  ws.onclose = () => { onlineCount = 0; updateOnline(); };
  ws.onerror = () => {};
  ws.onmessage = e => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if(d.type === 'message') addChatMsg(d.payload);
    else if(d.type === 'presence'){ onlineCount = Array.isArray(d.payload) ? d.payload.length : 0; updateOnline(); }
    else if(d.type === 'error') toast(d.payload || '发送失败', true);
  };
}
function addChatMsg(m){
  const box = $('#chatMessages');
  if(!box) return;
  const own = me && m.user_id === me.id;
  const el = document.createElement('div');
  el.className = 'chat-msg' + (own ? ' own' : '');
  el.innerHTML = `${avatarImg(m.username)}<div class="chat-bubble"><div class="who"><b>${esc(m.username)}</b><time>${new Date(m.created).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time></div><p>${esc(m.body)}</p></div>`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
function updateOnline(){ const el = $('#onlineCount'); if(el) el.textContent = onlineCount; }
async function refreshEventCard(){
  try {
    const evs = await api('/api/events?limit=1');
    const ev = evs[0];
    if(!ev) return;
    currentEventId = ev.id;
    $('#eventTitle').textContent = ev.title;
    $('#eventTime').textContent = new Date(ev.start_time).toLocaleString('zh-CN', {month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'});
    const btn = $('#eventJoinBtn');
    btn.textContent = ev.joined ? '✔ 已参加' : '我要参加';
    btn.classList.toggle('mini-btn', true);
  } catch {}
}

/* ---------- Modal ---------- */
function openModal(html){
  $('#modalRoot').innerHTML = `<div class="modal-mask"><div class="modal">${html}</div></div>`;
  $('#modalRoot .modal-mask').addEventListener('click', e => { if(e.target.classList.contains('modal-mask')) closeModal(); });
}
function closeModal(){ $('#modalRoot').innerHTML = ''; }

/* ---------- 全局事件委托 ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if(!el) return;
  const action = el.dataset.action;
  if(action === 'open-topic') openTopic(el.dataset.id);
  else if(action === 'filter'){ currentFilter = el.dataset.filter; viewTopics(); }
  else if(action === 'go-topics') viewTopics();
  else if(action === 'like') doLike(el);
  else if(action === 'fav') doFav(el);
  else if(action === 'event-join') doEventJoin(el);
  else if(action === 'emoji'){ const inp = $('#chatInput'); inp.value += el.dataset.e; inp.focus(); $('#emojiPop').classList.add('hidden'); }
  else if(action === 'close-modal') closeModal();
});
async function doLike(btn){
  try {
    const d = await api('/api/topics/' + btn.dataset.id + '/like', {method:'POST'});
    btn.classList.toggle('liked', d.liked);
    btn.textContent = '❤ ' + d.likes;
    if(d.liked) toast('已点赞 🔥');
  } catch(e){ toast(e.message, true); }
}
async function doFav(btn){
  try {
    const d = await api('/api/topics/' + btn.dataset.id + '/favorite', {method:'POST'});
    btn.classList.toggle('faved', d.faved);
    btn.textContent = '⭐ ' + (d.faved ? '已收藏' : '收藏');
  } catch(e){ toast(e.message, true); }
}
async function doEventJoin(btn){
  try {
    const d = await api('/api/events/' + btn.dataset.id + '/join', {method:'POST'});
    toast(d.joined ? '已参加活动' : '已取消参加');
    viewEvents();
  } catch(e){ toast(e.message, true); }
}

boot();
