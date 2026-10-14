import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const root = dirname(fileURLToPath(import.meta.url));
const data = resolve(process.env.DATA_DIR || resolve(root, 'data'));
mkdirSync(data, { recursive: true });
const uploads = resolve(root, 'uploads');
mkdirSync(uploads, { recursive: true });

const db = new DatabaseSync(resolve(data, 'forum.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,password TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',disabled INTEGER DEFAULT 0,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites(id INTEGER PRIMARY KEY,hash TEXT UNIQUE NOT NULL,expires INTEGER NOT NULL,used_by INTEGER REFERENCES users(id),revoked INTEGER DEFAULT 0,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS topics(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),title TEXT NOT NULL,body TEXT NOT NULL,category TEXT NOT NULL,created INTEGER NOT NULL,pinned INTEGER DEFAULT 0,closed INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS replies(id INTEGER PRIMARY KEY,topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,user_id INTEGER REFERENCES users(id),body TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),body TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS games(id INTEGER PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,url TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS likes(id INTEGER PRIMARY KEY,topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,user_id INTEGER REFERENCES users(id),created INTEGER NOT NULL,UNIQUE(topic_id,user_id));
CREATE TABLE IF NOT EXISTS favorites(id INTEGER PRIMARY KEY,topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,user_id INTEGER REFERENCES users(id),created INTEGER NOT NULL,UNIQUE(topic_id,user_id));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,title TEXT NOT NULL,start_time INTEGER NOT NULL,description TEXT DEFAULT '',creator_id INTEGER REFERENCES users(id),created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS event_participants(event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,user_id INTEGER REFERENCES users(id),created INTEGER NOT NULL,UNIQUE(event_id,user_id));
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),type TEXT NOT NULL,ref_id INTEGER,body TEXT NOT NULL,read INTEGER DEFAULT 0,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_likes_topic ON likes(topic_id);
CREATE INDEX IF NOT EXISTS idx_favs_user ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id,read);
`);

const now = () => Date.now();
const hash = s => createHash('sha256').update(s).digest('hex');
const stmt = (s, ...a) => db.prepare(s).run(...a);
const get = (s, ...a) => db.prepare(s).get(...a);
const all = (s, ...a) => db.prepare(s).all(...a);

function password(p){ const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(p, salt, 64).toString('hex'); }
function verify(p, stored){ const [salt, key] = stored.split(':'); return timingSafeEqual(scryptSync(p, salt, 64), Buffer.from(key, 'hex')); }
function validCredentials(u, p){
  if(typeof u !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(u)) throw Error('账号须为 3–24 位字母、数字或下划线');
  if(typeof p !== 'string' || p.length < 6 || p.length > 128) throw Error('密码须为 6–128 个字符');
}

if(!get('SELECT id FROM users WHERE role=?', 'admin') && process.env.ADMIN_PASSWORD){
  validCredentials('baiwan', process.env.ADMIN_PASSWORD);
  stmt('INSERT INTO users(username,password,role,created) VALUES(?,?,?,?)', 'baiwan', password(process.env.ADMIN_PASSWORD), 'admin', now());
}
if(process.env.NODE_ENV === 'production' && !get('SELECT id FROM users WHERE role=?', 'admin'))
  throw Error('首次生产启动必须设置 ADMIN_PASSWORD（至少 10 位）');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const sockets = new Set();
const buckets = new Map();

function limit(key, max, ms){
  const t = now();
  let b = buckets.get(key);
  if(!b || b.end < t){ b = { n: 0, end: t + ms }; buckets.set(key, b); }
  if(++b.n > max){ const e = Error('操作过于频繁，请稍后再试'); e.status = 429; throw e; }
}
setInterval(() => {
  for(const [k, v] of buckets) if(v.end < now()) buckets.delete(k);
  stmt('DELETE FROM sessions WHERE expires<?', now());
}, 60000).unref();

function cookie(req){ return /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]; }
function user(req){ return get('SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.disabled=0', hash(cookie(req) || ''), now()); }
function local(req){ return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || ''); }
function originOK(req){
  const origin = req.headers.origin;
  if(!origin) return false;
  return origin === (process.env.PUBLIC_ORIGIN || `http://${req.headers.host}`);
}
function broadcast(type, payload){ const data = JSON.stringify({ type, payload }); for(const s of sockets) if(s.readyState === WebSocket.OPEN) s.send(data); }
function presence(){
  const users = [...new Map([...sockets].filter(s => s.readyState === WebSocket.OPEN).map(s => [s.user.id, s.user])).values()];
  broadcast('presence', users);
}
function eject(id){ for(const s of sockets) if(s.user.id === id) s.close(1008, '会话已失效'); }
function text(v, min, max){ if(typeof v !== 'string' || v.trim().length < min || v.length > max) throw Error(`内容长度须为 ${min}–${max} 字符`); return v.trim(); }
function out(res, status, obj, headers = {}){ res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers }); res.end(JSON.stringify(obj)); }
async function body(req, maxBytes = 32768){
  let result = '';
  for await(const chunk of req){
    result += chunk;
    if(Buffer.byteLength(result) > maxBytes){ const e = Error('请求内容过长'); e.status = 413; throw e; }
  }
  try { return JSON.parse(result || '{}'); } catch { throw Error('请求格式不正确'); }
}
function session(res, id){
  const token = randomBytes(32).toString('hex');
  stmt('INSERT INTO sessions VALUES(?,?,?)', hash(token), id, now() + 7 * 86400000);
  return { 'Set-Cookie': `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` };
}
function addNotification(userId, type, refId, bodyText){
  stmt('INSERT INTO notifications(user_id,type,ref_id,body,created) VALUES(?,?,?,?,?)', userId, type, refId, bodyText, now());
}

/* ---------- 话题列表查询（筛选/排序/搜索） ---------- */
function topicList(u, qs){
  const where = [];
  const args = [];
  if(qs.category){ where.push('t.category = ?'); args.push(qs.category); }
  if(qs.q){
    where.push('(t.title LIKE ? OR t.body LIKE ? OR t.category LIKE ? OR u.username LIKE ?)');
    const like = `%${qs.q}%`;
    args.push(like, like, like, like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  let order = 't.pinned DESC, t.created DESC';
  if(qs.sort === 'replies') order = 't.pinned DESC, COALESCE((SELECT MAX(r.created) FROM replies r WHERE r.topic_id = t.id), t.created) DESC';
  else if(qs.sort === 'likes') order = 't.pinned DESC, (SELECT COUNT(*) FROM likes l WHERE l.topic_id = t.id) DESC, t.created DESC';
  const page = Math.max(Number(qs.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(qs.pageSize) || Number(qs.limit) || 20, 1), 50);
  const total = get(`SELECT COUNT(*) AS c FROM topics t JOIN users u ON t.user_id = u.id ${whereSql}`, ...args).c;
  const rows = all(`SELECT t.*, u.username,
      (SELECT COUNT(*) FROM replies r WHERE r.topic_id = t.id) AS replies,
      (SELECT COUNT(*) FROM likes l WHERE l.topic_id = t.id) AS likes
    FROM topics t JOIN users u ON t.user_id = u.id ${whereSql}
    ORDER BY ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, ...args);
  const uId = u ? u.id : 0;
  const likedSet = new Set(all('SELECT topic_id FROM likes WHERE user_id=?', uId).map(r => r.topic_id));
  const favedSet = new Set(all('SELECT topic_id FROM favorites WHERE user_id=?', uId).map(r => r.topic_id));
  return { topics: rows.map(t => ({ ...t, liked: likedSet.has(t.id), faved: favedSet.has(t.id) })), total, page, pageSize };
}

/* ---------- HTTP 服务 ---------- */
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; frame-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;
    const qs = Object.fromEntries(url.searchParams);

    if(!path.startsWith('/api/')){
      if(path.startsWith('/uploads/')){
        const name = path.slice('/uploads/'.length);
        if(!/^[a-f0-9]{16}\.(png|jpg|jpeg|gif|webp)$/i.test(name) || !existsSync(resolve(uploads, name)))
          return out(res, 404, { error: '图片不存在' });
        res.writeHead(200, {
          'Content-Type': name.endsWith('.png') ? 'image/png' : name.endsWith('.gif') ? 'image/gif' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable'
        });
        return res.end(readFileSync(resolve(uploads, name)));
      }
      const files = { '/':'index.html', '/app.js':'app.js', '/style.css':'style.css', '/campfire.png':'campfire.png' };
      const file = files[path];
      if(!file || !existsSync(resolve(root, 'public', file))) return out(res, 404, { error: '页面不存在' });
      res.writeHead(200, {
        'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : file.endsWith('.css') ? 'text/css; charset=utf-8'
          : file.endsWith('.png') ? 'image/png'
          : 'text/html; charset=utf-8'
      });
      return res.end(readFileSync(resolve(root, 'public', file)));
    }

    if(method !== 'GET' && !originOK(req)) return out(res, 403, { error: '请求来源不允许' });
    const u = user(req);

    if(path === '/api/me' && method === 'GET') return out(res, 200, { user: u || null, setup: !get('SELECT id FROM users WHERE role=?', 'admin') && local(req) });

    if(path === '/api/setup' && method === 'POST'){
      if(!local(req) || get('SELECT id FROM users WHERE role=?', 'admin')) return out(res, 403, { error: '初始化入口已关闭' });
      const b = await body(req);
      validCredentials('baiwan', b.password);
      const r = stmt('INSERT INTO users(username,password,role,created) VALUES(?,?,?,?)', 'baiwan', password(b.password), 'admin', now());
      return out(res, 201, { ok: true }, session(res, Number(r.lastInsertRowid)));
    }

    if(['/api/login', '/api/register'].includes(path) && method === 'POST'){
      limit(req.socket.remoteAddress + ':auth', 15, 60000);
      const b = await body(req);
      validCredentials(b.username, b.password);
      if(path.endsWith('login')){
        const found = get('SELECT * FROM users WHERE username=?', b.username);
        if(!found || found.disabled || !verify(b.password, found.password)) return out(res, 401, { error: '账号或密码不正确' });
        return out(res, 200, { ok: true }, session(res, found.id));
      }
      if(!get('SELECT id FROM users WHERE role=?', 'admin')) return out(res, 403, { error: '管理员尚未初始化' });
      db.exec('BEGIN IMMEDIATE');
      try {
        if(get('SELECT id FROM users WHERE username=?', b.username)) throw Error('该账号已被使用');
        const invite = get('SELECT * FROM invites WHERE hash=? AND expires>? AND revoked=0 AND used_by IS NULL', hash(String(b.invite || '').trim()), now());
        if(!invite) throw Error('邀请码无效、已过期或已被使用');
        const r = stmt('INSERT INTO users(username,password,created) VALUES(?,?,?)', b.username, password(b.password), now());
        stmt('UPDATE invites SET used_by=? WHERE id=?', Number(r.lastInsertRowid), invite.id);
        db.exec('COMMIT');
        return out(res, 201, { ok: true }, session(res, Number(r.lastInsertRowid)));
      } catch(e){ db.exec('ROLLBACK'); throw e; }
    }

    if(!u) return out(res, 401, { error: '请先登录' });

    if(path === '/api/logout' && method === 'POST'){
      stmt('DELETE FROM sessions WHERE token=?', hash(cookie(req) || ''));
      for(const s of sockets) if(s.token === hash(cookie(req) || '')) s.close(1008);
      return out(res, 200, { ok: true }, { 'Set-Cookie':'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    /* --- 图片上传 --- */
    if(path === '/api/upload' && method === 'POST'){
      limit(u.id + ':upload', 30, 60000);
      const b = await body(req, 8 * 1024 * 1024);
      const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
      if(!m) throw Error('仅支持 png/jpg/gif/webp 图片');
      const ext = m[1] === 'image/png' ? 'png' : m[1] === 'image/gif' ? 'gif' : m[1] === 'image/webp' ? 'webp' : 'jpg';
      const buf = Buffer.from(m[2], 'base64');
      if(!buf.length || buf.length > 5 * 1024 * 1024) throw Error('图片大小须在 5MB 以内');
      const name = randomBytes(8).toString('hex') + '.' + ext;
      writeFileSync(resolve(uploads, name), buf);
      return out(res, 201, { url: '/uploads/' + name });
    }

    if(path.startsWith('/api/admin/') && u.role !== 'admin') return out(res, 403, { error: '需要管理员权限' });

    /* --- 管理：邀请码 --- */
    if(path === '/api/admin/invites' && method === 'GET') return out(res, 200, all('SELECT i.id,i.expires,i.revoked,i.created,u.username AS used_by FROM invites i LEFT JOIN users u ON u.id=i.used_by ORDER BY i.id DESC LIMIT 100'));
    if(path === '/api/admin/invites' && method === 'POST'){
      const b = await body(req), hours = Number(b.hours);
      if(!Number.isFinite(hours) || hours < 1 || hours > 720) throw Error('有效期须为 1–720 小时');
      const code = randomBytes(12).toString('hex'), expires = now() + hours * 3600000;
      stmt('INSERT INTO invites(hash,expires,created) VALUES(?,?,?)', hash(code), expires, now());
      return out(res, 201, { code, expires });
    }
    if(/^\/api\/admin\/invites\/\d+$/.test(path) && method === 'DELETE'){
      stmt('UPDATE invites SET revoked=1 WHERE id=?', Number(path.split('/').at(-1)));
      return out(res, 200, { ok: true });
    }

    /* --- 管理：用户 --- */
    if(path === '/api/admin/users' && method === 'GET') return out(res, 200, all('SELECT id,username,role,disabled,created FROM users ORDER BY id'));
    if(path === '/api/admin/users' && method === 'POST'){
      const b = await body(req);
      validCredentials(b.username, b.password);
      if(get('SELECT id FROM users WHERE username=?', b.username)) throw Error('该账号已被使用');
      stmt('INSERT INTO users(username,password,created) VALUES(?,?,?)', b.username, password(b.password), now());
      return out(res, 201, { ok: true });
    }
    if(/^\/api\/admin\/users\/\d+$/.test(path) && method === 'PATCH'){
      const id = Number(path.split('/').at(-1)), target = get('SELECT * FROM users WHERE id=?', id), b = await body(req);
      if(!target) return out(res, 404, { error: '用户不存在' });
      if(target.role === 'admin') throw Error('不能禁用管理员');
      if(typeof b.disabled !== 'boolean') throw Error('状态无效');
      stmt('UPDATE users SET disabled=? WHERE id=?', b.disabled ? 1 : 0, id);
      if(b.disabled){ stmt('DELETE FROM sessions WHERE user_id=?', id); eject(id); }
      return out(res, 200, { ok: true });
    }

    /* --- 话题 --- */
    if(path === '/api/topics' && method === 'GET') return out(res, 200, topicList(u, qs));
    if(path === '/api/topics' && method === 'POST'){
      limit(u.id + ':topic', 10, 60000);
      const b = await body(req);
      const r = stmt('INSERT INTO topics(user_id,title,body,category,created) VALUES(?,?,?,?,?)', u.id, text(b.title, 1, 100), text(b.body, 1, 10000), text(b.category || '游戏讨论', 1, 30), now());
      broadcast('topics', null);
      return out(res, 201, { id: Number(r.lastInsertRowid) });
    }
    if(/^\/api\/topics\/\d+$/.test(path)){
      const id = Number(path.split('/').at(-1));
      const t = get('SELECT t.*,u.username FROM topics t JOIN users u ON u.id=t.user_id WHERE t.id=?', id);
      if(!t) return out(res, 404, { error: '话题不存在' });
      if(method === 'GET'){
        const likesCount = get('SELECT COUNT(*) AS c FROM likes WHERE topic_id=?', id).c;
        const replyPage = Math.max(Number(qs.page) || 1, 1);
        const replyPageSize = Math.min(Math.max(Number(qs.pageSize) || 20, 1), 50);
        const replyTotal = get('SELECT COUNT(*) AS c FROM replies WHERE topic_id=?', id).c;
        return out(res, 200, {
          ...t,
          likes: likesCount,
          liked: !!get('SELECT id FROM likes WHERE topic_id=? AND user_id=?', id, u.id),
          faved: !!get('SELECT id FROM favorites WHERE topic_id=? AND user_id=?', id, u.id),
          replyPage, replyPageSize, replyTotal,
          replies: all('SELECT r.*,u.username FROM replies r JOIN users u ON u.id=r.user_id WHERE topic_id=? ORDER BY r.created LIMIT ? OFFSET ?', id, replyPageSize, (replyPage - 1) * replyPageSize)
        });
      }
      if(u.id !== t.user_id && u.role !== 'admin') return out(res, 403, { error: '无权管理此话题' });
      if(method === 'DELETE'){
        stmt('DELETE FROM likes WHERE topic_id=?', id);
        stmt('DELETE FROM favorites WHERE topic_id=?', id);
        stmt('DELETE FROM topics WHERE id=?', id);
        broadcast('topics', null);
        return out(res, 200, { ok: true });
      }
      if(method === 'PATCH'){
        if(u.role !== 'admin') return out(res, 403, { error: '需要管理员权限' });
        const b = await body(req);
        if(typeof b.pinned !== 'boolean' || typeof b.closed !== 'boolean') throw Error('状态无效');
        stmt('UPDATE topics SET pinned=?,closed=? WHERE id=?', b.pinned ? 1 : 0, b.closed ? 1 : 0, id);
        broadcast('topics', null);
        return out(res, 200, { ok: true });
      }
    }

    /* --- 点赞 / 收藏 --- */
    if(/^\/api\/topics\/\d+\/like$/.test(path) && method === 'POST'){
      const id = Number(path.split('/')[3]);
      if(!get('SELECT id FROM topics WHERE id=?', id)) return out(res, 404, { error: '话题不存在' });
      const existing = get('SELECT id FROM likes WHERE topic_id=? AND user_id=?', id, u.id);
      if(existing) stmt('DELETE FROM likes WHERE id=?', existing.id);
      else stmt('INSERT INTO likes(topic_id,user_id,created) VALUES(?,?,?)', id, u.id, now());
      return out(res, 200, { liked: !existing, likes: get('SELECT COUNT(*) AS c FROM likes WHERE topic_id=?', id).c });
    }
    if(/^\/api\/topics\/\d+\/favorite$/.test(path) && method === 'POST'){
      const id = Number(path.split('/')[3]);
      if(!get('SELECT id FROM topics WHERE id=?', id)) return out(res, 404, { error: '话题不存在' });
      const existing = get('SELECT id FROM favorites WHERE topic_id=? AND user_id=?', id, u.id);
      if(existing) stmt('DELETE FROM favorites WHERE id=?', existing.id);
      else stmt('INSERT INTO favorites(topic_id,user_id,created) VALUES(?,?,?)', id, u.id, now());
      return out(res, 200, { faved: !existing });
    }
    if(path === '/api/favorites' && method === 'GET'){
      const rows = all(`SELECT t.*,u.username,
          (SELECT COUNT(*) FROM replies r WHERE r.topic_id=t.id) AS replies,
          (SELECT COUNT(*) FROM likes l WHERE l.topic_id=t.id) AS likes
        FROM favorites f JOIN topics t ON t.id=f.topic_id JOIN users u ON u.id=t.user_id
        WHERE f.user_id=? ORDER BY f.created DESC LIMIT 100`, u.id);
      return out(res, 200, { topics: rows.map(t => ({ ...t, liked: true, faved: true })) });
    }

    /* --- 回复 --- */
    if(/^\/api\/topics\/\d+\/replies$/.test(path) && method === 'POST'){
      limit(u.id + ':reply', 20, 60000);
      const id = Number(path.split('/')[3]);
      const t = get('SELECT * FROM topics WHERE id=?', id);
      if(!t) return out(res, 404, { error: '话题不存在' });
      if(t.closed) throw Error('该话题已关闭回复');
      const b = await body(req);
      stmt('INSERT INTO replies(topic_id,user_id,body,created) VALUES(?,?,?,?)', id, u.id, text(b.body, 1, 5000), now());
      if(t.user_id !== u.id) addNotification(t.user_id, 'reply', id, `${u.username} 回复了你的话题「${t.title}」`);
      broadcast('topics', null);
      return out(res, 201, { ok: true });
    }
    if(/^\/api\/replies\/\d+$/.test(path) && method === 'DELETE'){
      const id = Number(path.split('/').at(-1));
      const r = get('SELECT * FROM replies WHERE id=?', id);
      if(!r) return out(res, 404, { error: '回复不存在' });
      if(r.user_id !== u.id && u.role !== 'admin') return out(res, 403, { error: '无权删除' });
      stmt('DELETE FROM replies WHERE id=?', id);
      broadcast('topics', null);
      return out(res, 200, { ok: true });
    }

    /* --- 聊天消息 --- */
    if(path === '/api/messages' && method === 'GET') return out(res, 200, all('SELECT m.*,u.username FROM messages m JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 100').reverse());
    if(/^\/api\/messages\/\d+$/.test(path) && method === 'DELETE'){
      if(u.role !== 'admin') return out(res, 403, { error: '需要管理员权限' });
      const id = Number(path.split('/').at(-1));
      stmt('DELETE FROM messages WHERE id=?', id);
      broadcast('message-delete', id);
      return out(res, 200, { ok: true });
    }

    /* --- 游戏 --- */
    if(path === '/api/games' && method === 'GET') return out(res, 200, all('SELECT * FROM games ORDER BY id DESC'));
    if(path === '/api/admin/games' && method === 'POST'){
      const b = await body(req);
      let link;
      try { link = new URL(b.url); } catch { throw Error('请输入完整游戏网址'); }
      if(!['https:', 'http:'].includes(link.protocol)) throw Error('网址必须以 http 或 https 开头');
      stmt('INSERT INTO games(title,description,url) VALUES(?,?,?)', text(b.title, 1, 60), text(b.description || '朋友制作的游戏', 1, 200), link.href);
      return out(res, 201, { ok: true });
    }
    if(/^\/api\/admin\/games\/\d+$/.test(path) && method === 'DELETE'){
      stmt('DELETE FROM games WHERE id=?', Number(path.split('/').at(-1)));
      return out(res, 200, { ok: true });
    }

    /* --- 活动 --- */
    if(path === '/api/events' && method === 'GET'){
      const limitN = Math.min(Math.max(Number(qs.limit) || 50, 1), 100);
      const rows = all(`SELECT e.*,c.username AS creator_name,
          (SELECT COUNT(*) FROM event_participants p WHERE p.event_id=e.id) AS participants
        FROM events e JOIN users c ON c.id=e.creator_id ORDER BY e.start_time ASC LIMIT ${limitN}`);
      return out(res, 200, rows.map(ev => ({ ...ev, joined: !!get('SELECT 1 FROM event_participants WHERE event_id=? AND user_id=?', ev.id, u.id) })));
    }
    if(path === '/api/events' && method === 'POST'){
      limit(u.id + ':event', 5, 60000);
      const b = await body(req);
      const start = Number(b.start_time);
      if(!Number.isFinite(start) || start < now() - 60000) throw Error('活动时间须为未来时间');
      const r = stmt('INSERT INTO events(title,start_time,description,creator_id,created) VALUES(?,?,?,?,?)', text(b.title, 1, 60), start, text(b.description || '', 0, 500), u.id, now());
      return out(res, 201, { id: Number(r.lastInsertRowid) });
    }
    if(/^\/api\/events\/\d+\/join$/.test(path) && method === 'POST'){
      const id = Number(path.split('/')[3]);
      const ev = get('SELECT * FROM events WHERE id=?', id);
      if(!ev) return out(res, 404, { error: '活动不存在' });
      const existing = get('SELECT 1 FROM event_participants WHERE event_id=? AND user_id=?', id, u.id);
      if(existing) stmt('DELETE FROM event_participants WHERE event_id=? AND user_id=?', id, u.id);
      else {
        stmt('INSERT INTO event_participants(event_id,user_id,created) VALUES(?,?,?)', id, u.id, now());
        if(ev.creator_id !== u.id) addNotification(ev.creator_id, 'event', id, `${u.username} 报名参加了你发起的活动「${ev.title}」`);
      }
      return out(res, 200, { joined: !existing });
    }

    /* --- 通知 --- */
    if(path === '/api/notifications' && method === 'GET'){
      const rows = all('SELECT * FROM notifications WHERE user_id=? ORDER BY created DESC LIMIT 50', u.id);
      const unread = get('SELECT COUNT(*) AS c FROM notifications WHERE user_id=? AND read=0', u.id).c;
      return out(res, 200, { unread, notifications: rows });
    }
    if(path === '/api/notifications/read' && method === 'POST'){
      stmt('UPDATE notifications SET read=1 WHERE user_id=? AND read=0', u.id);
      return out(res, 200, { ok: true });
    }

    /* --- 个人资料 --- */
    if(path === '/api/my/stats' && method === 'GET'){
      const me = get('SELECT created FROM users WHERE id=?', u.id);
      const topics = get('SELECT COUNT(*) AS c FROM topics WHERE user_id=?', u.id).c;
      const replies = get('SELECT COUNT(*) AS c FROM replies WHERE user_id=?', u.id).c;
      const likes_given = get('SELECT COUNT(*) AS c FROM likes WHERE user_id=?', u.id).c;
      const favorites = get('SELECT COUNT(*) AS c FROM favorites WHERE user_id=?', u.id).c;
      return out(res, 200, { created: me.created, topics, replies, likes_given, favorites });
    }
    if(path === '/api/my/topics' && method === 'GET'){
      const rows = all(`SELECT t.*,u.username,
          (SELECT COUNT(*) FROM replies r WHERE r.topic_id=t.id) AS replies,
          (SELECT COUNT(*) FROM likes l WHERE l.topic_id=t.id) AS likes
        FROM topics t JOIN users u ON u.id=t.user_id WHERE t.user_id=? ORDER BY t.created DESC LIMIT 100`, u.id);
      return out(res, 200, { topics: rows });
    }

    return out(res, 404, { error: '接口不存在' });
  } catch(e){
    if(!res.headersSent) out(res, e.status || 400, { error: e.message.includes('UNIQUE') ? '账号已存在' : e.message });
    else res.end();
  }
});

/* ---------- WebSocket 聊天 ---------- */
const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
server.on('upgrade', (req, socket, head) => {
  const u = user(req);
  if(req.url !== '/ws' || !u || !originOK(req)){ socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, s => {
    s.user = u;
    s.token = hash(cookie(req) || '');
    s.alive = true;
    sockets.add(s);
    s.on('error', () => {});
    s.on('pong', () => s.alive = true);
    presence();
    s.on('close', () => { sockets.delete(s); presence(); });
    s.on('message', data => {
      try {
        const valid = get('SELECT s.token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.disabled=0', s.token, now());
        if(!valid) return s.close(1008);
        limit(u.id + ':chat', 12, 10000);
        const b = JSON.parse(data.toString());
        const bodyText = text(b.body, 1, 2000);
        const r = stmt('INSERT INTO messages(user_id,body,created) VALUES(?,?,?)', u.id, bodyText, now());
        broadcast('message', { id: Number(r.lastInsertRowid), user_id: u.id, username: u.username, body: bodyText, created: now() });
      } catch(e){ s.send(JSON.stringify({ type: 'error', payload: e.message })); }
    });
  });
});
setInterval(() => {
  for(const s of sockets){
    if(!s.alive){ s.terminate(); continue; }
    s.alive = false;
    s.ping();
    if(!get('SELECT token FROM sessions WHERE token=? AND expires>?', s.token, now())) s.close(1008);
  }
}, 30000).unref();

server.listen(port, host, () => console.log(`Campfire Arcade: http://${host}:${port}\n${get('SELECT id FROM users WHERE role=?', 'admin') ? '管理员账号：baiwan' : '请在本机浏览器打开页面，初始化 baiwan 的密码。'}`));
