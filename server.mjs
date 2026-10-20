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
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires INTEGER NOT NULL,ua TEXT DEFAULT '',created_at INTEGER DEFAULT 0);
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

/* ---------- 数据库迁移（users 表新增个人资料列，不重建表） ---------- */
const AVATAR_COLORS = ['#f59e0b','#79e1c2','#f472b6','#a78bfa','#60a5fa','#fb923c','#34d399','#f87171','#38bdf8','#c084fc'];
const usersCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
const ensureCol = (name, ddl) => { if(!usersCols.includes(name)) db.exec('ALTER TABLE users ADD COLUMN ' + ddl); };
ensureCol('display_name', "display_name TEXT DEFAULT ''");
ensureCol('avatar_color', "avatar_color TEXT DEFAULT ''");
ensureCol('title', "title TEXT DEFAULT ''");
/* ---------- 数据库迁移（sessions 表补充 ua/created_at，兼容已有行） ---------- */
const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
const ensureSessionCol = (name, ddl) => { if(!sessionCols.includes(name)) db.exec('ALTER TABLE sessions ADD COLUMN ' + ddl); };
ensureSessionCol('ua', "ua TEXT DEFAULT ''");
ensureSessionCol('created_at', "created_at INTEGER DEFAULT 0");

/* ========== RPG 数据迁移（player / items 表） ========== */
db.exec(`
  CREATE TABLE IF NOT EXISTS player (
    user_id INTEGER PRIMARY KEY,
    race TEXT NOT NULL DEFAULT '',
    level INTEGER NOT NULL DEFAULT 1,
    exp INTEGER NOT NULL DEFAULT 0,
    gold INTEGER NOT NULL DEFAULT 0,
    max_hp INTEGER NOT NULL DEFAULT 100,
    cur_hp INTEGER NOT NULL DEFAULT 100,
    attack INTEGER NOT NULL DEFAULT 12,
    defense INTEGER NOT NULL DEFAULT 5,
    crit_rate INTEGER NOT NULL DEFAULT 5,
    crit_dmg INTEGER NOT NULL DEFAULT 150,
    gold_bonus INTEGER NOT NULL DEFAULT 0,
    daily_count INTEGER NOT NULL DEFAULT 0,
    last_dungeon_date TEXT NOT NULL DEFAULT '',
    chapter INTEGER NOT NULL DEFAULT 1,
    boss_kills_ch1 INTEGER NOT NULL DEFAULT 0,
    boss_kills_ch2 INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    quality TEXT NOT NULL DEFAULT 'normal',
    stats TEXT NOT NULL DEFAULT '{}',
    location TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_items_owner ON items(owner_id);
  CREATE TABLE IF NOT EXISTS marketplace (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL,
    seller_name TEXT NOT NULL DEFAULT '',
    item_name TEXT NOT NULL,
    item_type TEXT NOT NULL,
    item_quality TEXT NOT NULL DEFAULT 'normal',
    item_stats TEXT NOT NULL DEFAULT '{}',
    quantity INTEGER NOT NULL DEFAULT 1,
    price INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_market_status ON marketplace(status, expires_at);
  /* 交易行（P4）：在售挂单 / 成交记录 */
  CREATE TABLE IF NOT EXISTS market_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL,
    seller_name TEXT NOT NULL DEFAULT '',
    item_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    item_type TEXT NOT NULL,
    item_quality TEXT NOT NULL DEFAULT 'normal',
    item_stats TEXT NOT NULL DEFAULT '{}',
    quantity INTEGER NOT NULL DEFAULT 1,
    price INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_listings_status ON market_listings(status, expires_at);
  CREATE INDEX IF NOT EXISTS idx_listings_seller ON market_listings(seller_id, status);
  CREATE TABLE IF NOT EXISTS market_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL,
    seller_id INTEGER NOT NULL,
    seller_name TEXT NOT NULL DEFAULT '',
    buyer_id INTEGER NOT NULL,
    buyer_name TEXT NOT NULL DEFAULT '',
    item_name TEXT NOT NULL,
    item_type TEXT NOT NULL,
    item_quality TEXT NOT NULL DEFAULT 'normal',
    item_stats TEXT NOT NULL DEFAULT '{}',
    quantity INTEGER NOT NULL DEFAULT 1,
    price INTEGER NOT NULL,
    fee INTEGER NOT NULL DEFAULT 0,
    seller_gain INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trades_buyer ON market_trades(buyer_id, created);
  CREATE INDEX IF NOT EXISTS idx_trades_seller ON market_trades(seller_id, created);
  /* 章节目标（P0）：目标定义 / 领取记录 / 动态统计辅助表 */
  CREATE TABLE IF NOT EXISTS chapter_goals (
    id INTEGER PRIMARY KEY,
    chapter INTEGER NOT NULL,
    type TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL DEFAULT 1,
    reward_gold INTEGER NOT NULL DEFAULT 0,
    reward_items TEXT NOT NULL DEFAULT '[]',
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS goal_claims (
    user_id INTEGER NOT NULL,
    goal_id INTEGER NOT NULL,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, goal_id)
  );
  CREATE TABLE IF NOT EXISTS monster_kills (
    user_id INTEGER NOT NULL,
    monster TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, monster)
  );
  CREATE TABLE IF NOT EXISTS encounter_log (
    user_id INTEGER NOT NULL,
    encounter TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, encounter)
  );
  CREATE TABLE IF NOT EXISTS dungeon_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chapter INTEGER NOT NULL,
    win INTEGER NOT NULL DEFAULT 0,
    completed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dungeon_runs_user ON dungeon_runs(user_id, chapter, win);
  /* 每日任务（P1）：当日任务定义 / 当日增量计数 / 领取记录 */
  CREATE TABLE IF NOT EXISTS daily_tasks (
    date TEXT NOT NULL,
    slot INTEGER NOT NULL,
    type TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL DEFAULT 1,
    reward_gold INTEGER NOT NULL DEFAULT 0,
    reward_items TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (date, slot)
  );
  CREATE TABLE IF NOT EXISTS daily_counts (
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date, kind, target)
  );
  CREATE TABLE IF NOT EXISTS daily_task_claims (
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    slot INTEGER NOT NULL,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, date, slot)
  );
  /* 随机事件（P2）：玩家当前待处理事件，选择后清除，同时刻至多 1 个 */
  CREATE TABLE IF NOT EXISTS pending_events (
    user_id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  /* 成就（P5）：成就定义 / 玩家进度与解锁领取记录 */
  CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    desc TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL DEFAULT 1,
    reward_gold INTEGER NOT NULL DEFAULT 0,
    reward_items TEXT NOT NULL DEFAULT '[]',
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS achievement_progress (
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    unlocked_at INTEGER,
    claimed_at INTEGER,
    PRIMARY KEY (user_id, code)
  );
`);

/* player 自动药水配置迁移（第 5 节：可关闭 / 改阈值 / 改次数） */
const playerCols2 = db.prepare('PRAGMA table_info(player)').all().map(c => c.name);
const ensurePlayerCol = (name, ddl) => { if(!playerCols2.includes(name)) db.exec('ALTER TABLE player ADD COLUMN ' + ddl); };
ensurePlayerCol('auto_potion', "auto_potion INTEGER NOT NULL DEFAULT 1");
ensurePlayerCol('potion_threshold', "potion_threshold INTEGER NOT NULL DEFAULT 35");
ensurePlayerCol('potion_limit', "potion_limit INTEGER NOT NULL DEFAULT 1");

/* player 转生配置迁移（P5：转生次数 / 称号 / 永久加成） */
ensurePlayerCol('reincarnate_count', "reincarnate_count INTEGER NOT NULL DEFAULT 0");
ensurePlayerCol('reincarnate_title', "reincarnate_title TEXT NOT NULL DEFAULT ''");
ensurePlayerCol('reincarnate_bonus_hp', "reincarnate_bonus_hp INTEGER NOT NULL DEFAULT 0");
ensurePlayerCol('reincarnate_bonus_atk', "reincarnate_bonus_atk INTEGER NOT NULL DEFAULT 0");
ensurePlayerCol('reincarnate_bonus_def', "reincarnate_bonus_def INTEGER NOT NULL DEFAULT 0");
ensurePlayerCol('reincarnate_bonus_crit', "reincarnate_bonus_crit INTEGER NOT NULL DEFAULT 0");

/* ========== RPG 数值配置（第 2、3、7 节） ========== */
const RACE_CONFIG = {
  '人族': { name:'人族', tag:'坚韧', max_hp:10, fail_gold_loss:0.05 },
  '精灵': { name:'精灵', tag:'精准', crit_rate:10, defense:-1, drop_bonus:5 },
  '矮人': { name:'矮人', tag:'锻体', defense:3, boss_dmg_reduce:0.10, crit_rate:-5 },
  '魔族': { name:'魔族', tag:'狂热', attack:4, low_hp_attack:6, low_hp_threshold:0.30, fail_gold_loss:0.15 }
};
const INIT_STATS = { level:1, exp:0, gold:0, max_hp:100, cur_hp:100, attack:12, defense:5, crit_rate:5, crit_dmg:150, gold_bonus:0 };
const LEVEL_UP_GROWTH = { max_hp:20, attack:3, defense:1 };
const START_ITEM = { name:'小木剑', type:'weapon', quality:'normal', stats:{ attack:2 }, location:'equipped_weapon' };
const ITEM_QUALITY_MULT = { normal:1.00, fine:1.20, superb:1.45, rare:1.75, legendary:2.20 };

/* ========== 长线养成（P5）：等级曲线 1-100 与转生配置 ========== */
const MAX_LEVEL = 100;
/* 经验需求分段线性递增：1-10 沿用 level*100，后续四段平滑抬升，100 级满级 */
function expNeedFor(level){
  if(level <= 10) return level * 100;
  if(level <= 20) return Math.floor(1000 + (level - 10) * 150);
  if(level <= 40) return Math.floor(2500 + (level - 20) * 250);
  if(level <= 70) return Math.floor(7500 + (level - 40) * 500);
  return Math.floor(22500 + (level - 70) * 1250);
}
const REINCARNATE_TITLES = ['浴火重生', '星火燎原', '百炼成钢', '超凡入圣', '万世轮回'];
function reincarnateTitle(n){
  if(!n) return '';
  return n <= REINCARNATE_TITLES.length ? REINCARNATE_TITLES[n - 1] : '轮回·' + n + '世';
}

/* ========== 阶段2：副本与战斗配置（第 3/4/6 节） ========== */
const DUNGEON_DAILY_LIMIT = 5;

/* ========== 每日任务（P1）：任务池 / 日期种子固定选取 ========== */
const DAILY_TASK_POOL = [
  { type:'clear', target:'任意副本', amount:2, reward_gold:200, reward_items:[] },
  { type:'clear', target:'任意副本', amount:1, reward_gold:150, reward_items:[{ name:'净化碎片', type:'material', quantity:2 }] },
  { type:'kill', target:'灰牙野狼', amount:10, reward_gold:150, reward_items:[{ name:'粗糙皮革', type:'material', quantity:2 }] },
  { type:'kill', target:'腐木妖', amount:8, reward_gold:160, reward_items:[] },
  { type:'kill', target:'黑斑巨狼', amount:3, reward_gold:220, reward_items:[{ box:true }] },
  { type:'kill', target:'矿坑蝙蝠', amount:10, reward_gold:180, reward_items:[{ name:'黑铁矿', type:'material', quantity:2 }] },
  { type:'kill', target:'黑铁傀儡', amount:6, reward_gold:240, reward_items:[{ box:true }] },
  { type:'forge', target:'铁匠铺制作', amount:3, reward_gold:180, reward_items:[{ name:'精炼黑铁', type:'material', quantity:1 }] },
  { type:'forge', target:'铁匠铺制作', amount:5, reward_gold:300, reward_items:[{ box:true }] },
  { type:'shop', target:'商店购买', amount:2, reward_gold:120, reward_items:[] },
  { type:'shop', target:'商店购买', amount:3, reward_gold:220, reward_items:[{ name:'精制皮革', type:'material', quantity:1 }] }
];
const DAILY_TASK_TYPE_CN = { clear:'通关副本', kill:'击杀敌人', forge:'制作物品', shop:'商店购买' };

/* ========== 随机事件（P2）：事件池 / 触发后写入 pending_events，选择后清除 ==========
 * 选项效果 effects（顺序执行）：
 *   { type:'gold', amount }          金币增减（负数为扣除，不足时清零）
 *   { type:'hp', amount }            生命增减（负数为受伤，最低 1；恢复不超过上限）
 *   { type:'item', name,type,quality,stats,quantity }  物品入包
 *   { type:'equip', text }           从当前章节装备池 roll 一件装备
 *   { type:'nothing', text }         无事发生（仅日志文案）
 *   { type:'branch', text, branches:[{pct,text,effects}] }  概率随机分支
 * 选项可选 cost 字段：用于「购买」类选项，金币不足时接口返回 400 */
const RANDOM_EVENTS = [
  {
    id: 'roadside_chest', title: '路边宝箱', desc: '旅途中发现一只落满灰尘的宝箱，锁扣已经锈蚀。',
    choices: [
      { label: '谨慎开箱', effects: [
        { type: 'branch', text: '你缓缓掀开箱盖…', branches: [
          { pct: 0.6, text: '里面竟是一袋沉甸甸的金币！', effects: [{ type: 'gold', amount: 60 }] },
          { pct: 0.4, text: '触发了暗弩机关，你被射中受伤。', effects: [{ type: 'hp', amount: -20 }] }
        ] }
      ] },
      { label: '无视离开', effects: [{ type: 'nothing', text: '你摇摇头继续赶路，与宝藏无缘。' }] }
    ]
  },
  {
    id: 'mystery_merchant', title: '神秘商人', desc: '兜帽商人拦住你，掀开斗篷露出几件泛光的货物。',
    choices: [
      { label: '购买「精制皮革」（40 金币）', cost: 40, effects: [
        { type: 'gold', amount: -40 },
        { type: 'item', name: '精制皮革', item_type: 'material', quality: 'normal', quantity: 2 },
        { type: 'nothing', text: '商人递过皮革，你付了 40 金币。' }
      ] },
      { label: '购买「小型药水」（30 金币）', cost: 30, effects: [
        { type: 'gold', amount: -30 },
        { type: 'item', name: '小型药水', type: 'consumable', quality: 'normal', stats: { heal_pct: 30 }, quantity: 1 },
        { type: 'nothing', text: '一瓶泛着微光的药水到手，你花了 30 金币。' }
      ] },
      { label: '摇头离开', effects: [{ type: 'nothing', text: '商人不以为意，很快消失在路旁。' }] }
    ]
  },
  {
    id: 'thorn_trap', title: '荆棘陷阱', desc: '前方草丛中隐约露出尖锐的捕兽夹，铁齿泛着寒光。',
    choices: [
      { label: '小心绕行', effects: [
        { type: 'branch', text: '你蹑手蹑脚地绕行…', branches: [
          { pct: 0.75, text: '有惊无险，你顺利通过。', effects: [{ type: 'nothing', text: '' }] },
          { pct: 0.25, text: '一脚踩空，捕兽夹咬住你的小腿！', effects: [{ type: 'hp', amount: -25 }] }
        ] }
      ] },
      { label: '强行通过', effects: [
        { type: 'hp', amount: -30 },
        { type: 'nothing', text: '你莽撞地冲过去，被夹了个正着。' }
      ] }
    ]
  },
  {
    id: 'ruin_discovery', title: '遗迹发现', desc: '断壁残垣之下，一柄锈蚀的长剑半埋在土中。',
    choices: [
      { label: '仔细挖掘', effects: [{ type: 'equip', text: '你掘出武器，拂去尘土后寒光乍现！' }] },
      { label: '搜刮残骸', effects: [{ type: 'gold', amount: 35 }, { type: 'nothing', text: '你在碎石间摸出一小袋金币。' }] }
    ]
  },
  {
    id: 'traveler_help', title: '旅人求助', desc: '一位疲惫的旅人拦住你，请求分些干粮与盘缠。',
    choices: [
      { label: '慷慨相助（-15 金币）', cost: 15, effects: [
        { type: 'gold', amount: -15 },
        { type: 'item', name: '粗糙皮革', item_type: 'material', quality: 'normal', quantity: 1 },
        { type: 'hp', amount: 10 },
        { type: 'nothing', text: '旅人感激不尽，赠你皮革并为你包扎了伤口。' }
      ] },
      { label: '婉言拒绝', effects: [{ type: 'nothing', text: '旅人叹了口气，转身离去。' }] }
    ]
  },
  {
    id: 'weather_omen', title: '天气异象', desc: '天空骤然暗沉，雷云在头顶翻滚聚拢。',
    choices: [
      { label: '原地躲避', effects: [{ type: 'nothing', text: '你躲进岩缝，等雷雨过去。' }] },
      { label: '冒雨赶路', effects: [
        { type: 'branch', text: '你顶着风雨前行…', branches: [
          { pct: 0.6, text: '雨水冲出一片矿脉，你捡到两块黑铁矿！', effects: [{ type: 'item', name: '黑铁矿', item_type: 'material', quality: 'normal', quantity: 2 }] },
          { pct: 0.4, text: '一道惊雷劈下，你被震得浑身发麻。', effects: [{ type: 'hp', amount: -20 }] }
        ] }
      ] }
    ]
  },
  {
    id: 'mystic_spring', title: '神秘泉水', desc: '林间石缝中涌出一泓幽蓝清泉，水光潋滟。',
    choices: [
      { label: '饮下泉水', effects: [{ type: 'hp', amount: 40 }, { type: 'nothing', text: '泉水入喉，暖流涌遍全身。' }] },
      { label: '装满一瓶', effects: [
        { type: 'item', name: '神秘泉水', type: 'consumable', quality: 'fine', stats: { heal_pct: 50 }, quantity: 1 },
        { type: 'nothing', text: '你装了一瓶幽蓝泉水带走。' }
      ] },
      { label: '泼洒测试', effects: [{ type: 'nothing', text: '泉水落地后迅速渗入泥土，并无异样。' }] }
    ]
  },
  {
    id: 'lost_elder', title: '迷途老者', desc: '白发老者拉住你问路，却怎么也说不清要去的地方。',
    choices: [
      { label: '耐心指引', effects: [{ type: 'gold', amount: 25 }, { type: 'nothing', text: '老者恍然大悟，硬塞给你 25 金币作谢礼。' }] },
      { label: '打听宝藏', effects: [{ type: 'item', name: '猎人旧地图', item_type: 'quest', quality: 'normal', quantity: 1 }, { type: 'nothing', text: '老者低声透露了一处宝藏的位置。' }] }
    ]
  },
  {
    id: 'abandoned_camp', title: '废弃营帐', desc: '路边立着一座废弃营帐，篝火早已熄灭。',
    choices: [
      { label: '翻找行囊', effects: [{ type: 'item', name: '精炼黑铁', item_type: 'material', quality: 'normal', quantity: 1 }, { type: 'nothing', text: '你在行囊底翻出一块精炼黑铁。' }] },
      { label: '烧毁营帐', effects: [{ type: 'nothing', text: '火焰腾起，营帐化为灰烬，无事发生。' }] }
    ]
  },
  {
    id: 'mist_whisper', title: '黑雾低语', desc: '一缕黑雾在路边盘旋，隐约传来低语声。',
    choices: [
      { label: '侧耳聆听', effects: [
        { type: 'item', name: '净化碎片', item_type: 'material', quality: 'normal', quantity: 1 },
        { type: 'hp', amount: -10 },
        { type: 'nothing', text: '低语侵蚀心神，但碎片遗落在地，你捡了起来。' }
      ] },
      { label: '快步离开', effects: [{ type: 'nothing', text: '你加快脚步，将低语甩在身后。' }] }
    ]
  }
];
function hashSeed(str){ let h = 0; for(let i = 0; i < str.length; i++){ h = (h * 31 + str.charCodeAt(i)) >>> 0; } return h >>> 0; }
function mulberry32(seed){ let a = seed >>> 0; return function(){ a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/* 按日期种子每天固定选取 3 个不同类型任务，当天全服一致 */
function pickDailyTasks(dateStr){
  const rnd = mulberry32(hashSeed('daily:' + dateStr));
  const byType = {};
  for(const t of DAILY_TASK_POOL){ (byType[t.type] = byType[t.type] || []).push(t); }
  const types = Object.keys(byType);
  for(let i = types.length - 1; i > 0; i--){ const j = Math.floor(rnd() * (i + 1)); [types[i], types[j]] = [types[j], types[i]]; }
  return types.slice(0, Math.min(3, types.length)).map(type => {
    const pool = byType[type].slice();
    for(let i = pool.length - 1; i > 0; i--){ const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return pool[0];
  });
}
/* 确保当天任务已生成（幂等；跨日自然日 0 点后再次请求即生成新一天任务） */
function ensureDailyTasks(dateStr){
  const exists = get('SELECT date FROM daily_tasks WHERE date=? LIMIT 1', dateStr);
  if(exists) return;
  const picked = pickDailyTasks(dateStr);
  picked.forEach((t, i) => {
    stmt('INSERT INTO daily_tasks(date,slot,type,target,amount,reward_gold,reward_items) VALUES(?,?,?,?,?,?,?)',
      dateStr, i + 1, t.type, t.target, t.amount, t.reward_gold, JSON.stringify(t.reward_items || []));
  });
}
const MAX_BATTLE_TURNS = 80;
const QUALITY_ORDER = ['normal', 'fine', 'superb', 'rare', 'legendary'];

const MONSTER_CONFIG = {
  /* 第一章：灰烬森林 */
  '灰牙野狼': { chapter:1, tier:'normal', kind:'野兽', hp:40, attack:9, defense:2, exp:25, gold:[5,10], extra_dmg:{ pct:0.20, amount:3 } },
  '腐木妖':   { chapter:1, tier:'normal', kind:'构装体', hp:55, attack:8, defense:5, exp:30, gold:[5,12], atk_down_next:{ pct:0.20 } },
  '林间盗匪': { chapter:1, tier:'normal', kind:'人型', hp:65, attack:12, defense:3, exp:40, gold:[10,20], first_turn_atk:5 },
  '黑斑巨狼': { chapter:1, tier:'elite', kind:'野兽', hp:120, attack:17, defense:6, exp:90, gold:[20,35], enrage_hp:0.50, enrage_atk:5, armor_break_every:3, armor_break_amt:2, armor_break_dur:2 },
  '灰烬狼王': { chapter:1, tier:'boss', kind:'野兽', hp:220, attack:20, defense:7, exp:180, gold:[50,80], rend_every:3, rend_mult:1.5, bleed_pct:0.30, bleed_dmg:5, bleed_dur:2, enrage_hp:0.30, enrage_atk:6, enrage_crit:10 },
  /* 第二章：沉没矿坑（数据录入备用） */
  '矿坑蝙蝠':     { chapter:2, tier:'normal', kind:'野兽', hp:70, attack:15, defense:4, exp:55, gold:[10,18], no_crit_next:{ pct:0.25 } },
  '黑铁傀儡':     { chapter:2, tier:'normal', kind:'构装体', hp:130, attack:17, defense:10, exp:75, gold:[15,25], armor_on_hit_every:3, armor_on_hit_amt:3, armor_on_hit_max:2 },
  '黑雾祭司':     { chapter:2, tier:'normal', kind:'黑雾', hp:100, attack:20, defense:6, exp:85, gold:[18,30], curse:{ atk:-3, dur:3 }, heal_hp:0.40, heal_amt:25 },
  '黑铁守卫':     { chapter:2, tier:'elite', kind:'构装体', hp:210, attack:25, defense:12, exp:140, gold:[30,45], shield_extra:10, shield_next_reduce:0.30, crit_counter:10 },
  '矿坑领主莫拉克': { chapter:2, tier:'boss', kind:'黑雾', hp:340, attack:27, defense:10, exp:320, gold:[100,150], surge_every:3, surge_dmg:25, surge_def:3, summon_hp:0.60, summon_reduce:0.20, frenzy_hp:0.20, frenzy_atk:8, frenzy_dot:5 }
};

/* 第一章装备池（掉落原型，品质由掉落 roll 决定；desc 用于展示） */
const CH1_EQUIP = [
  { name:'猎人短弓', type:'weapon', stats:{ attack:6, crit_rate:5 }, desc:'林间猎人的制式短弓，弓弦紧绷、射程不俗。' },
  { name:'狼牙短刃', type:'weapon', stats:{ attack:9, beast_hp_low_dmg:3 }, desc:'以狼牙磨制的短刃，对濒死的野兽格外锋利。' },
  { name:'猎人长弓', type:'weapon', stats:{ attack:12, crit_rate:8 }, desc:'上等猎弓，拉满弦时能洞穿两棵树后的猎物。' },
  { name:'旧皮甲', type:'armor', stats:{ defense:3, max_hp:10 }, desc:'陈旧的皮甲，边缘磨得发亮，仍能挡下几刀。' },
  { name:'狼皮护肩', type:'armor', stats:{ defense:5, beast_dmg_reduce:0.10 }, desc:'狼皮缝制的护肩，坚韧且带着野兽的余威。' },
  { name:'荆棘皮甲', type:'armor', stats:{ defense:6, max_hp:15 }, desc:'缠满荆棘藤条的皮甲，防御与生机兼备。' },
  { name:'猎人护符', type:'accessory', stats:{ crit_rate:5 }, desc:'刻着猎获标记的木符，佩戴者出手更加刁钻。' },
  { name:'盗匪腰包', type:'accessory', stats:{ gold_bonus:15, defense:-1 }, desc:'从盗匪身上搜来的腰包，鼓鼓囊囊装满油水。' },
  { name:'木雕护符', type:'accessory', stats:{ max_hp:15 }, desc:'粗糙的木雕护符，却蕴含着旺盛的生命力。' }
];
/* 第二章装备池 */
const CH2_EQUIP = [
  { name:'黑铁战斧', type:'weapon', stats:{ attack:16, crit_dmg:20, crit_rate:-5 }, desc:'沉甸甸的黑铁战斧，一击可劈开岩壁。' },
  { name:'净化法杖', type:'weapon', stats:{ attack:11, undead_dmg:0.25 }, desc:'附着净化符文的法杖，对黑暗之物伤害倍增。' },
  { name:'精铁大剑', type:'weapon', stats:{ attack:19, crit_dmg:15 }, desc:'矿工锻造的精铁大剑，剑锋泛着寒光。' },
  { name:'黑铁胸甲', type:'armor', stats:{ defense:10, max_hp:30, heal_pct_penalty:0.10 }, desc:'重甲防护周全，但灵药难以渗入铠甲。' },
  { name:'矿工重铠', type:'armor', stats:{ defense:13, big_hit_reduce:10 }, desc:'矿工们合力打造的厚重铠甲，能卸掉致命重击。' },
  { name:'守卫徽章', type:'accessory', stats:{ defense:4, high_hp_reduce:0.05 }, desc:'矿坑守卫的徽章，满血时愈显坚不可摧。' },
  { name:'矿坑领主戒指', type:'accessory', stats:{ attack:5, defense:3, death_save:1 }, desc:'领主陨落后遗留的戒指，能在绝境中护主一次。' },
  { name:'矿灯坠饰', type:'accessory', stats:{ attack:4, crit_rate:10 }, desc:'以矿灯晶石打磨的坠饰，黑暗中熠熠生辉。' }
];

/* 装备名称 → 描述映射（入库物品不含 desc 列，展示时按名称补全） */
const EQUIP_DESC = {};
[...CH1_EQUIP, ...CH2_EQUIP].forEach(e => { EQUIP_DESC[e.name] = e.desc || ''; });

const ENCOUNTER_CONFIG = {
  '采药人':   { chapter:1, desc:'你在林间遇到一位采药人。', choices:['帮助他（恢复15点生命并得到小型药水）', '索要药材（获得15金币，但下场敌人攻击+3）'] },
  '神秘树洞': { chapter:1, desc:'一棵巨树下有个发光的树洞。', choices:['伸手进去（60%获得20金币，40%受到15点伤害）', '仔细搜索（必得一件普通饰品）'] },
  '猎人营地': { chapter:1, desc:'一座空无一人的猎人营地。', choices:['搜刮营地（获得5-15金币与粗糙皮革，20%获得猎人旧地图）'] },
  '被困矿工': { chapter:2, desc:'废弃矿道里传来呼救声。', choices:['救出他（损失10生命，得40金币）', '搜刮矿工遗物（得黑铁矿，但下场敌人防御+3）'] },
  '黑雾祭坛': { chapter:2, desc:'一座散发黑雾的祭坛。', choices:['摧毁祭坛（损失20生命，得净化碎片）', '研究祭坛（临时强化，50%获得诅咒）', '祈祷（恢复20生命，但下场必为精英战）'] },
  '地底商人': { chapter:2, desc:'地下通道中有一位神秘商人。', choices:['购买随机商品（3件随机商品只能买1件，每局最多一次）'] }
};

const CHAPTER_CONFIG = {
  1: { name:'灰烬森林', normal:['灰牙野狼','腐木妖','林间盗匪'], elite:['黑斑巨狼'], boss:'灰烬狼王', encounters:['采药人','神秘树洞','猎人营地'], equip:CH1_EQUIP, drop:'boss1', normal_mat:['枯木','粗糙皮革'], elite_mat:['黑狼牙'], boss_mat:['黑狼牙','黑狼牙'] },
  2: { name:'沉没矿坑', normal:['矿坑蝙蝠','黑铁傀儡','黑雾祭司'], elite:['黑铁守卫'], boss:'矿坑领主莫拉克', encounters:['被困矿工','黑雾祭坛','地底商人'], equip:CH2_EQUIP, drop:'boss2', normal_mat:['黑铁矿'], elite_mat:['黑铁矿','黑铁矿'], boss_mat:['净化碎片','黑铁矿'] }
};

/* 章节目标配置（P0，第 8 节）：每章 3~5 个目标
 * type: clear=通关副本 | kill=击败指定敌人 | encounter=完成遭遇 | collect=收集材料 | boss=击败章节Boss
 * reward_items: [{name,type,quality,stats,quantity}] 或 [{box:true}]（装备箱=随机装备，按 box 掉落表 roll）
 */
const CHAPTER_GOALS = {
  1: [
    { id: 1, chapter: 1, type: 'clear', target: '灰烬森林', amount: 1, reward_gold: 60, reward_items: [], sort: 1 },
    { id: 2, chapter: 1, type: 'kill', target: '灰牙野狼', amount: 3, reward_gold: 0, reward_items: [{ name: '粗糙皮革', type: 'material', quality: 'normal', stats: {}, quantity: 2 }], sort: 2 },
    { id: 3, chapter: 1, type: 'encounter', target: '神秘树洞', amount: 1, reward_gold: 0, reward_items: [{ name: '猎人护符', type: 'accessory', quality: 'normal', stats: { crit_rate: 5 }, quantity: 1 }], sort: 3 },
    { id: 4, chapter: 1, type: 'collect', target: '枯木', amount: 5, reward_gold: 0, reward_items: [{ name: '小型药水', type: 'consumable', quality: 'normal', stats: { heal_pct: 30 }, quantity: 2 }], sort: 4 },
    { id: 5, chapter: 1, type: 'boss', target: '灰烬狼王', amount: 1, reward_gold: 0, reward_items: [{ box: true }], sort: 5 }
  ],
  2: [
    { id: 6, chapter: 2, type: 'clear', target: '沉没矿坑', amount: 1, reward_gold: 100, reward_items: [], sort: 1 },
    { id: 7, chapter: 2, type: 'kill', target: '黑铁傀儡', amount: 3, reward_gold: 0, reward_items: [{ name: '黑铁矿', type: 'material', quality: 'normal', stats: {}, quantity: 2 }], sort: 2 },
    { id: 8, chapter: 2, type: 'encounter', target: '黑雾祭坛', amount: 1, reward_gold: 0, reward_items: [{ name: '净化碎片', type: 'material', quality: 'normal', stats: {}, quantity: 1 }], sort: 3 },
    { id: 9, chapter: 2, type: 'collect', target: '黑铁矿', amount: 5, reward_gold: 0, reward_items: [{ name: '中型药水', type: 'consumable', quality: 'normal', stats: { heal_pct: 50 }, quantity: 1 }], sort: 4 },
    { id: 10, chapter: 2, type: 'boss', target: '矿坑领主莫拉克', amount: 1, reward_gold: 0, reward_items: [{ box: true }], sort: 5 }
  ]
};
/* 启动时写入目标定义（固定 id，重复启动幂等） */
{
  const seedGoals = [];
  for(const ch of Object.values(CHAPTER_GOALS)) for(const g of ch) seedGoals.push(g);
  const goalStmt = db.prepare('INSERT OR IGNORE INTO chapter_goals(id,chapter,type,target,amount,reward_gold,reward_items,sort) VALUES(?,?,?,?,?,?,?,?)');
  for(const g of seedGoals) goalStmt.run(g.id, g.chapter, g.type, g.target, g.amount, g.reward_gold, JSON.stringify(g.reward_items), g.sort);
}

/* 掉落概率（P3：普通/优良/精良/稀有/传说，白→金 5 档） */
const DROP_TABLE = {
  normal: { normal:0.16, fine:0.07, superb:0.018, rare:0.002, legendary:0.0004 },
  elite:  { normal:0.30, fine:0.18, superb:0.06, rare:0.01, legendary:0.003 },
  boss1:  { normal:0.30, fine:0.40, superb:0.25, rare:0.05, legendary:0.01 },
  boss2:  { normal:0.20, fine:0.35, superb:0.35, rare:0.10, legendary:0.03 },
  box:    { normal:0.60, fine:0.30, superb:0.08, rare:0.02, legendary:0.005 }
};

const POTION_ITEMS = { '小型药水': { heal_pct:30 }, '中型药水': { heal_pct:50 } };

/* ========== RPG 阶段3 配置（第 7 节：铁匠铺 / 商店 / 交易行） ========== */
/* 材料合成（4 种：低阶材料 → 高阶材料，用于高级装备与药水制作） */
const CRAFT_MATERIAL = {
  '精制皮革': { cost:20, ingredients:{ '粗糙皮革':2 } },
  '精炼黑铁': { cost:30, ingredients:{ '黑铁矿':2 } },
  '锐利狼牙': { cost:40, ingredients:{ '黑狼牙':2 } },
  '净化结晶': { cost:50, ingredients:{ '净化碎片':2 } }
};
/* 药水制作 */
const CRAFT_POTION = {
  '小型药水': { cost:20, ingredients:{ '枯木':2 } },
  '中型药水': { cost:50, ingredients:{ '精制皮革':1, '黑铁矿':1 } }
};
/* 第一章装备制作（固定普通品质） */
const CRAFT_EQUIP_1 = {
  '猎人短弓': { cost:60, ingredients:{ '粗糙皮革':2, '枯木':2 } },
  '狼牙短刃': { cost:50, ingredients:{ '黑狼牙':2 } },
  '旧皮甲': { cost:50, ingredients:{ '粗糙皮革':3 } },
  '狼皮护肩': { cost:70, ingredients:{ '粗糙皮革':2, '黑狼牙':1 } },
  '猎人护符': { cost:40, ingredients:{ '枯木':3 } },
  '盗匪腰包': { cost:80, ingredients:{ '粗糙皮革':2, '黑狼牙':2 } },
  '木雕护符': { cost:30, ingredients:{ '枯木':2 } }
};
/* 第二章装备制作（固定优良品质，需高阶材料） */
const CRAFT_EQUIP_2 = {
  '黑铁战斧': { cost:120, ingredients:{ '黑铁矿':3, '黑狼牙':2 } },
  '净化法杖': { cost:130, ingredients:{ '净化碎片':2, '黑铁矿':2 } },
  '黑铁胸甲': { cost:140, ingredients:{ '黑铁矿':3, '黑狼牙':1 } },
  '矿工重铠': { cost:180, ingredients:{ '黑铁矿':4, '精炼黑铁':1 } },
  '守卫徽章': { cost:100, ingredients:{ '黑铁矿':2, '净化碎片':1 } },
  '矿坑领主戒指': { cost:200, ingredients:{ '净化碎片':2, '黑铁矿':2, '精炼黑铁':1 } }
};
/* 商店商品 */
const SHOP_ITEMS = {
  '小型药水': { type:'consumable', stats:{ heal_pct:30 }, price:20 },
  '普通装备箱': { type:'equip_box', price:120 },
  '枯木': { type:'material', price:8 },
  '粗糙皮革': { type:'material', price:15 },
  '黑铁矿': { type:'material', price:25 },
  '黑狼牙': { type:'material', price:30 },
  '净化碎片': { type:'material', price:35 }
};
/* 交易行（P4）：48 小时保存、5% 手续费 */
const MARKET_FEE = 0.05;
const MARKET_DURATION = 48 * 3600 * 1000;
/* 背包直接出售 NPC（体验打磨）：装备按品质回收，材料按商店基础单价 */
const SELL_QUALITY_PRICE = { normal: 10, fine: 25, superb: 60, rare: 150, legendary: 400 };
/* 地底商人随机商品池（每次出现随机 3 件，只能买 1 件） */
const MERCHANT_GOODS = [
  { name:'小型药水', type:'consumable', quality:'normal', stats:{ heal_pct:30 }, price:20 },
  { name:'中型药水', type:'consumable', quality:'normal', stats:{ heal_pct:50 }, price:60 },
  { name:'粗糙皮革', type:'material', quality:'normal', stats:{}, price:15 },
  { name:'黑铁矿', type:'material', quality:'normal', stats:{}, price:25 },
  { name:'净化碎片', type:'material', quality:'normal', stats:{}, price:35 },
  { name:'精制皮革', type:'material', quality:'normal', stats:{}, price:50 },
  { name:'黑铁战斧', type:'weapon', quality:'normal', stats:{ attack:16, crit_dmg:20, crit_rate:-5 }, price:150 }
];

/* ========== RPG 属性计算（第 2、3 节） ========== */
function safeJson(s, fb){ if(Array.isArray(s)) return s; if(s !== null && typeof s === 'object') return s; try { return JSON.parse(s || '{}'); } catch { return fb; } }
function getPlayer(userId){ return get('SELECT * FROM player WHERE user_id=?', userId); }
function getPlayerItems(userId){ return all('SELECT * FROM items WHERE owner_id=? ORDER BY id', userId).map(r => ({ ...r, stats: safeJson(r.stats, {}) })); }

/* 战力估算（P3）：生命 + 攻×3 + 防×2 + 暴击率×1.5 + 爆伤×0.5 + 金币加成×2 */
function calcPower(maxHp, attack, defense, critRate, critDmg, goldBonus){
  return Math.floor(Number(maxHp) + Number(attack) * 3 + Number(defense) * 2 + Number(critRate) * 1.5 + Number(critDmg) * 0.5 + Number(goldBonus) * 2);
}

/* 最终属性 = 等级基础 + 种族修正 + 装备加成（爆伤为加法叠加） */
function computeStats(p, items){
  if(!p) return null;
  const eq = (items || []).filter(it => it.location.startsWith('equipped_'));
  const sum = key => eq.reduce((t, it) => t + (Number(it.stats[key]) || 0), 0);
  const race = RACE_CONFIG[p.race] || {};
  const maxHp = p.max_hp + (race.max_hp || 0) + sum('max_hp');
  const attack = p.attack + (race.attack || 0) + sum('attack');
  const defense = p.defense + (race.defense || 0) + sum('defense');
  const crit_rate = p.crit_rate + (race.crit_rate || 0) + sum('crit_rate');
  const crit_dmg = p.crit_dmg + sum('crit_dmg');
  const gold_bonus = p.gold_bonus + sum('gold_bonus');
  return {
    user_id: p.user_id, race: p.race, level: p.level, exp: p.exp,
    exp_need: expNeedFor(p.level), max_level: MAX_LEVEL,
    gold: p.gold, max_hp: maxHp, cur_hp: p.cur_hp <= 0 ? maxHp : Math.min(p.cur_hp, maxHp),
    attack, defense, crit_rate, crit_dmg, gold_bonus,
    power: calcPower(maxHp, attack, defense, crit_rate, crit_dmg, gold_bonus),
    daily_count: p.daily_count, last_dungeon_date: p.last_dungeon_date, chapter: p.chapter,
    boss_kills_ch1: p.boss_kills_ch1, boss_kills_ch2: p.boss_kills_ch2, created: p.created,
    reincarnate_count: p.reincarnate_count || 0,
    reincarnate_title: p.reincarnate_title || ''
  };
}
/* 伤害计算（第 3 节）：普通=max(1,攻-防)；暴击=普通×爆伤倍率；多减伤相乘；最终向下取整且最低 1 */
function calcAttackDamage(stats, targetDefense, opts = {}){
  let dmg = Math.max(1, stats.attack - targetDefense);
  if(opts.crit) dmg *= (stats.crit_dmg || 150) / 100;
  for(const r of (opts.reducers || [])) dmg *= (1 - r);
  return Math.max(1, Math.floor(dmg));
}
function buildCharacter(userId){
  const p = getPlayer(userId);
  if(!p) return null;
  const items = getPlayerItems(userId);
  /* 血量兜底：非副本战斗中的角色若 cur_hp<=0（历史脏数据/中断异常），读取时按满血恢复并写库，保证面板永不显示 0 血 */
  if(p.cur_hp <= 0 && !dungeonSessions.has(userId)){
    const s0 = computeStats(p, items);
    if(p.cur_hp !== s0.max_hp){
      p.cur_hp = s0.max_hp;
      stmt('UPDATE player SET cur_hp=? WHERE user_id=?', s0.max_hp, userId);
    }
  }
  const s = computeStats(p, items);
  const equipped = items.filter(it => it.location.startsWith('equipped_')).map(it => ({ id:it.id, name:it.name, type:it.type, quality:it.quality, stats:it.stats, location:it.location, desc:EQUIP_DESC[it.name] || '' }));
  return { ...s, equipped };
}
function buildBackpack(userId){
  const items = getPlayerItems(userId);
  const groups = { equipment: [], consumable: [], material: [], quest: [] };
  const stack = new Map();
  for(const it of items){
    if(['weapon','armor','accessory'].includes(it.type)){
      if(it.location === 'backpack') groups.equipment.push({ ...it, desc: EQUIP_DESC[it.name] || '' });
      continue;
    }
    const g = it.type === 'consumable' ? groups.consumable : it.type === 'material' ? groups.material : groups.quest;
    const key = it.type + ':' + it.name + ':' + JSON.stringify(it.stats);
    const found = stack.get(key);
    if(found){ found.quantity += it.quantity; continue; }
    const row = { id:it.id, name:it.name, type:it.type, quality:it.quality, stats:it.stats, quantity:it.quantity, location:it.location };
    stack.set(key, row);
    g.push(row);
  }
  return groups;
}

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
function user(req){ return get('SELECT u.id,u.username,u.role,u.display_name,u.avatar_color,u.title FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.disabled=0', hash(cookie(req) || ''), now()); }
function local(req){ return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || ''); }
function originOK(req){
  const origin = req.headers.origin;
  if(!origin) return false;
  const publicOrigin = (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  if(publicOrigin && origin.replace(/\/+$/, '') === publicOrigin) return true;
  const o = origin.replace(/^https?:\/\//i, '').replace(/\/+$/, '').replace(/:\d+$/, '');
  const h = String(req.headers.host || '').replace(/\/+$/, '').replace(/:\d+$/, '');
  return o === h;
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
function session(req, res, id){
  const token = randomBytes(32).toString('hex');
  /* 单会话模式：同一账号登录/注册成功时踢掉其他旧会话 */
  stmt('DELETE FROM sessions WHERE user_id=?', id);
  stmt('INSERT INTO sessions(token,user_id,expires,ua,created_at) VALUES(?,?,?,?,?)', hash(token), id, now() + 7 * 86400000, String(req.headers['user-agent'] || '').slice(0, 200), now());
  eject(id);
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
  const rows = all(`SELECT t.*, u.username, u.display_name, u.avatar_color, u.title,
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
const dungeonSessions = new Map(); // 模块级：副本会话跨请求持久

/* 静态资源白名单（集中成常量，补齐全部 favicon 别名与 PWA manifest） */
const STATIC_FILES = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
  '/site.webmanifest': 'site.webmanifest',

  '/favicon.ico': 'favicon.ico',
  '/favicon.png': 'favicon.png',
  '/favicon-16.png': 'favicon-16.png',
  '/favicon-32.png': 'favicon-32.png',
  '/favicon-48.png': 'favicon-48.png',
  '/favicon-64.png': 'favicon-64.png',
  '/favicon-192.png': 'favicon-192.png',
  '/favicon-512.png': 'favicon-512.png',

  '/favicon-16x16.png': 'favicon-16x16.png',
  '/favicon-32x32.png': 'favicon-32x32.png',
  '/favicon-48x48.png': 'favicon-48x48.png',
  '/favicon-64x64.png': 'favicon-64x64.png',
  '/favicon-192x192.png': 'favicon-192x192.png',
  '/favicon-512x512.png': 'favicon-512x512.png',

  '/apple-touch-icon.png': 'apple-touch-icon.png',
  '/android-chrome-192x192.png': 'android-chrome-192x192.png',
  '/android-chrome-512x512.png': 'android-chrome-512x512.png'
};
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
      const file = STATIC_FILES[path];
      if(!file || !existsSync(resolve(root, 'public', file))) return out(res, 404, { error: '页面不存在' });
      res.writeHead(200, {
        'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : file.endsWith('.css') ? 'text/css; charset=utf-8'
          : file.endsWith('.webmanifest') ? 'application/manifest+json'
          : file.endsWith('.png') ? 'image/png'
          : file.endsWith('.ico') ? 'image/x-icon'
          : 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      return res.end(readFileSync(resolve(root, 'public', file)));
    }

    if(method !== 'GET' && !originOK(req)) return out(res, 403, { error: '请求来源不允许' });
    const u = user(req);

    if(path === '/api/me' && method === 'GET'){
      const setup = !get('SELECT id FROM users WHERE role=?', 'admin') && local(req);
      if(!u) return out(res, 401, { error: '未登录', setup });
      return out(res, 200, { user: u, setup });
    }

    if(path === '/api/setup' && method === 'POST'){
      if(!local(req) || get('SELECT id FROM users WHERE role=?', 'admin')) return out(res, 403, { error: '初始化入口已关闭' });
      const b = await body(req);
      validCredentials('baiwan', b.password);
      const r = stmt('INSERT INTO users(username,password,role,created) VALUES(?,?,?,?)', 'baiwan', password(b.password), 'admin', now());
      return out(res, 201, { ok: true }, session(req, res, Number(r.lastInsertRowid)));
    }

    if(['/api/login', '/api/register'].includes(path) && method === 'POST'){
      limit(req.socket.remoteAddress + ':auth', 15, 60000);
      const b = await body(req);
      validCredentials(b.username, b.password);
      if(path.endsWith('login')){
        const found = get('SELECT * FROM users WHERE username=?', b.username);
        if(!found || found.disabled || !verify(b.password, found.password)) return out(res, 401, { error: '账号或密码不正确' });
        return out(res, 200, { ok: true }, session(req, res, found.id));
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
        return out(res, 201, { ok: true }, session(req, res, Number(r.lastInsertRowid)));
      } catch(e){ db.exec('ROLLBACK'); throw e; }
    }

    if(!u) return out(res, 401, { error: '请先登录' });

    /* ========== 会话管理（第 1 节：列会话 / 踢除会话） ========== */
    if(path === '/api/sessions' && method === 'GET'){
      const cur = hash(cookie(req) || '');
      const rows = all('SELECT token,expires,ua,created_at FROM sessions WHERE user_id=? ORDER BY created_at DESC', u.id);
      return out(res, 200, { sessions: rows.map(r => ({ id: r.token.slice(0, 8), current: r.token === cur, expires: r.expires, ua: r.ua || '', created_at: r.created_at || 0 })) });
    }
    if(path === '/api/sessions/kick' && method === 'POST'){
      const b = await body(req);
      const id = String(b.id || '').slice(0, 8);
      const cur = hash(cookie(req) || '');
      const rows = all('SELECT token FROM sessions WHERE user_id=?', u.id);
      const target = rows.find(r => r.token.startsWith(id));
      if(!target) return out(res, 404, { error: '会话不存在' });
      if(target.token === cur) return out(res, 400, { error: '不能踢除当前会话' });
      stmt('DELETE FROM sessions WHERE token=?', target.token);
      return out(res, 200, { ok: true });
    }

    /* ========== RPG 接口（第 2、8 节） ========== */
    if(path === '/api/rpg/character/create' && method === 'POST'){
      const b = await body(req);
      const race = String(b.race || '').trim();
      if(!RACE_CONFIG[race]) return out(res, 400, { error: '种族无效，可选：人族、精灵、矮人、魔族' });
      if(get('SELECT user_id FROM player WHERE user_id=?', u.id)) return out(res, 400, { error: '已创建角色，无法重复创建' });
      const t = now();
      stmt('INSERT INTO player(user_id,race,level,exp,gold,max_hp,cur_hp,attack,defense,crit_rate,crit_dmg,gold_bonus,daily_count,last_dungeon_date,chapter,boss_kills_ch1,boss_kills_ch2,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        u.id, race, INIT_STATS.level, INIT_STATS.exp, INIT_STATS.gold, INIT_STATS.max_hp, INIT_STATS.cur_hp, INIT_STATS.attack, INIT_STATS.defense, INIT_STATS.crit_rate, INIT_STATS.crit_dmg, INIT_STATS.gold_bonus, 0, '', 1, 0, 0, t);
      stmt('INSERT INTO items(owner_id,name,type,quality,stats,location,quantity,created) VALUES(?,?,?,?,?,?,?,?)',
        u.id, START_ITEM.name, START_ITEM.type, START_ITEM.quality, JSON.stringify(START_ITEM.stats), START_ITEM.location, 1, t);
      return out(res, 201, { ok:true, character: buildCharacter(u.id) });
    }
    if(path === '/api/rpg/character' && method === 'GET'){
      const c = buildCharacter(u.id);
      if(!c) return out(res, 404, { error: '尚未创建角色' });
      return out(res, 200, { character: c });
    }
    if(path === '/api/rpg/backpack' && method === 'GET'){
      const p = getPlayer(u.id);
      if(!p) return out(res, 404, { error: '尚未创建角色' });
      return out(res, 200, { gold: p.gold, backpack: buildBackpack(u.id) });
    }
    if(path === '/api/rpg/equipment' && method === 'GET'){
      const p = getPlayer(u.id);
      if(!p) return out(res, 404, { error: '尚未创建角色' });
      const c = buildCharacter(u.id);
      const eqList = (buildBackpack(u.id).equipment || []).map(it => ({ id: it.id, name: it.name, type: it.type, quality: it.quality, stats: it.stats, desc: it.desc, location: 'backpack' }));
      return out(res, 200, { power: c.power, gold: p.gold, equipped: c.equipped, equipment: eqList });
    }
    if(path === '/api/rpg/equipment/equip' && method === 'POST'){
      const b = await body(req);
      const item = get('SELECT * FROM items WHERE id=?', Number(b.item_id) || 0);
      if(!item) return out(res, 404, { error: '物品不存在' });
      if(item.owner_id !== u.id) return out(res, 400, { error: '无权穿戴该物品' });
      if(!['weapon','armor','accessory'].includes(item.type)) return out(res, 400, { error: '该物品无法装备' });
      if(item.location !== 'backpack') return out(res, 400, { error: '该物品不在背包中' });
      const target = 'equipped_' + item.type;
      const old = get('SELECT id FROM items WHERE owner_id=? AND location=?', u.id, target);
      if(old) return out(res, 400, { error: '已有同类装备，请先卸下' });
      stmt('UPDATE items SET location=? WHERE id=?', target, item.id);
      return out(res, 200, { ok:true, character: buildCharacter(u.id) });
    }
    if(path === '/api/rpg/equipment/unequip' && method === 'POST'){
      const b = await body(req);
      const item = get('SELECT * FROM items WHERE id=?', Number(b.item_id) || 0);
      if(!item) return out(res, 404, { error: '物品不存在' });
      if(item.owner_id !== u.id) return out(res, 400, { error: '无权卸下该物品' });
      if(!item.location.startsWith('equipped_')) return out(res, 400, { error: '该物品不在装备栏' });
      stmt('UPDATE items SET location=? WHERE id=?', 'backpack', item.id);
      return out(res, 200, { ok:true, character: buildCharacter(u.id) });
    }
    /* 旧路径兼容：/api/rpg/equip、/api/rpg/unequip（同逻辑，互斥改为 400） */
    if(path === '/api/rpg/equip' && method === 'POST'){
      const b = await body(req);
      const item = get('SELECT * FROM items WHERE id=?', Number(b.item_id) || 0);
      if(!item) return out(res, 404, { error: '物品不存在' });
      if(item.owner_id !== u.id) return out(res, 400, { error: '无权穿戴该物品' });
      if(!['weapon','armor','accessory'].includes(item.type)) return out(res, 400, { error: '该物品无法装备' });
      if(item.location !== 'backpack') return out(res, 400, { error: '该物品不在背包中' });
      const target = 'equipped_' + item.type;
      const old = get('SELECT id FROM items WHERE owner_id=? AND location=?', u.id, target);
      if(old) return out(res, 400, { error: '已有同类装备，请先卸下' });
      stmt('UPDATE items SET location=? WHERE id=?', target, item.id);
      return out(res, 200, { ok:true, character: buildCharacter(u.id) });
    }
    if(path === '/api/rpg/unequip' && method === 'POST'){
      const b = await body(req);
      const item = get('SELECT * FROM items WHERE id=?', Number(b.item_id) || 0);
      if(!item) return out(res, 404, { error: '物品不存在' });
      if(item.owner_id !== u.id) return out(res, 400, { error: '无权卸下该物品' });
      if(!item.location.startsWith('equipped_')) return out(res, 400, { error: '该物品不在装备栏' });
      stmt('UPDATE items SET location=? WHERE id=?', 'backpack', item.id);
      return out(res, 200, { ok:true, character: buildCharacter(u.id) });
    }




const localDateStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const rollPct = (p) => Math.random() < p;
const raceFailGoldLoss = (race) => { const r = RACE_CONFIG[race] || {}; return r.fail_gold_loss != null ? r.fail_gold_loss : 0.10; };
const shuffleArr = (a) => { for(let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function addItem(ownerId, name, type, quality, stats, location, quantity){
  quantity = quantity || 1;
  if(location === 'backpack' && ['consumable', 'material'].includes(type)){
    const row = get('SELECT id FROM items WHERE owner_id=? AND name=? AND type=? AND quality=? AND location=?', ownerId, name, type, quality, 'backpack');
    if(row){ stmt('UPDATE items SET quantity=quantity+? WHERE id=?', quantity, row.id); return row.id; }
  }
  const r = stmt('INSERT INTO items(owner_id,name,type,quality,stats,location,quantity,created) VALUES(?,?,?,?,?,?,?,?)', ownerId, name, type, quality, JSON.stringify(stats || {}), location, quantity, now());
  return Number(r.lastInsertRowid);
}
function consumeItem(ownerId, itemId, n){
  n = n || 1;
  const it = get('SELECT * FROM items WHERE id=? AND owner_id=?', itemId, ownerId);
  if(!it) return false;
  if(it.quantity <= n) stmt('DELETE FROM items WHERE id=?', itemId);
  else stmt('UPDATE items SET quantity=quantity-? WHERE id=?', n, itemId);
  return true;
}
function hasAndConsumeOldMap(userId){
  const row = get('SELECT * FROM items WHERE owner_id=? AND name=? AND type=? AND location=?', userId, '猎人旧地图', 'quest', 'backpack');
  if(!row) return false;
  consumeItem(userId, row.id, 1);
  return true;
}

/* ========== 章节目标（P0）：动态统计 / 领取（第 8 节） ========== */
function recordMonsterKill(userId, monster){
  stmt('INSERT INTO monster_kills(user_id,monster,count) VALUES(?,?,1) ON CONFLICT(user_id,monster) DO UPDATE SET count=count+1', userId, monster);
  dailyCountInc(userId, 'kill', monster, 1);
}
function recordEncounter(userId, encounter){
  stmt('INSERT INTO encounter_log(user_id,encounter,count) VALUES(?,?,1) ON CONFLICT(user_id,encounter) DO UPDATE SET count=count+1', userId, encounter);
}
function recordDungeonRun(userId, chapter, win){
  stmt('INSERT INTO dungeon_runs(user_id,chapter,win,completed_at) VALUES(?,?,?,?)', userId, chapter, win ? 1 : 0, now());
}
/* 单目标进度：完全基于现有数据动态统计，不新增采集逻辑 */
function goalProgressOf(userId, goal){
  switch(goal.type){
    case 'clear': {
      const r = get('SELECT COUNT(*) AS c FROM dungeon_runs WHERE user_id=? AND chapter=? AND win=1', userId, goal.chapter);
      return Number(r.c) || 0;
    }
    case 'kill': {
      const r = get('SELECT count FROM monster_kills WHERE user_id=? AND monster=?', userId, goal.target);
      return Number(r && r.count) || 0;
    }
    case 'encounter': {
      const r = get('SELECT count FROM encounter_log WHERE user_id=? AND encounter=?', userId, goal.target);
      return Number(r && r.count) || 0;
    }
    case 'collect': {
      const r = get('SELECT COALESCE(SUM(quantity),0) AS c FROM items WHERE owner_id=? AND name=? AND type=? AND location=?', userId, goal.target, 'material', 'backpack');
      return Number(r.c) || 0;
    }
    case 'boss': {
      const p = getPlayer(userId);
      if(!p) return 0;
      return goal.chapter === 2 ? p.boss_kills_ch2 : p.boss_kills_ch1;
    }
    default: return 0;
  }
}
const GOAL_TYPE_CN = { clear: '通关副本', kill: '击败敌人', encounter: '完成遭遇', collect: '收集材料', boss: '击败Boss' };
function goalPayload(userId, row){
  const g = { id: row.id, chapter: row.chapter, type: row.type, type_cn: GOAL_TYPE_CN[row.type] || row.type, target: row.target, amount: row.amount, sort: row.sort, reward: { gold: row.reward_gold, items: safeJson(row.reward_items, []) } };
  g.progress = goalProgressOf(userId, g);
  g.done = g.progress >= g.amount;
  g.claimed = !!get('SELECT user_id FROM goal_claims WHERE user_id=? AND goal_id=?', userId, g.id);
  g.claimable = g.done && !g.claimed;
  return g;
}
function listChapterGoals(userId, chapter){
  const rows = chapter
    ? all('SELECT * FROM chapter_goals WHERE chapter=? ORDER BY sort,id', chapter)
    : all('SELECT * FROM chapter_goals ORDER BY chapter,sort,id');
  return rows.map(r => goalPayload(userId, r));
}
/* ========== 每日任务（P1）：当日增量计数 / 进度统计 / 领取（第 9 节） ========== */
function dailyCountInc(userId, kind, target, qty){
  const today = localDateStr();
  stmt('INSERT INTO daily_counts(user_id,date,kind,target,count) VALUES(?,?,?,?,?) ON CONFLICT(user_id,date,kind,target) DO UPDATE SET count=count+excluded.count',
    userId, today, kind, target || '', qty || 1);
}
function dayStartMs(dateStr){ const parts = dateStr.split('-').map(Number); return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0).getTime(); }
/* 每日任务进度：clear 动态统计当日通关；kill/forge/shop 用当日增量计数表 */
function dailyProgressOf(userId, task){
  const today = localDateStr();
  if(task.type === 'clear'){
    const r = get('SELECT COUNT(*) AS c FROM dungeon_runs WHERE user_id=? AND win=1 AND completed_at>=?', userId, dayStartMs(today));
    return Number(r.c) || 0;
  }
  if(task.type === 'kill'){
    const r = get('SELECT COALESCE(SUM(count),0) AS c FROM daily_counts WHERE user_id=? AND date=? AND kind=? AND target=?', userId, today, 'kill', task.target);
    return Number(r.c) || 0;
  }
  if(task.type === 'forge' || task.type === 'shop'){
    const r = get('SELECT COALESCE(SUM(count),0) AS c FROM daily_counts WHERE user_id=? AND date=? AND kind=?', userId, today, task.type);
    return Number(r.c) || 0;
  }
  return 0;
}
function dailyPayload(userId, row){
  const g = { slot: row.slot, date: row.date, type: row.type, type_cn: DAILY_TASK_TYPE_CN[row.type] || row.type, target: row.target, amount: row.amount, reward: { gold: row.reward_gold, items: safeJson(row.reward_items, []) } };
  g.progress = dailyProgressOf(userId, g);
  g.done = g.progress >= g.amount;
  g.claimed = !!get('SELECT user_id FROM daily_task_claims WHERE user_id=? AND date=? AND slot=?', userId, row.date, row.slot);
  g.claimable = g.done && !g.claimed;
  return g;
}
async function handleDailyTasks(req, res, u){
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const today = localDateStr();
  ensureDailyTasks(today);
  const rows = all('SELECT * FROM daily_tasks WHERE date=? ORDER BY slot', today);
  return out(res, 200, { date: today, tasks: rows.map(r => dailyPayload(u.id, r)) });
}
async function handleDailyTaskClaim(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const today = localDateStr();
  ensureDailyTasks(today);
  const slot = Number(b.slot) || 0;
  const row = get('SELECT * FROM daily_tasks WHERE date=? AND slot=?', today, slot);
  if(!row) return out(res, 404, { error: '任务不存在' });
  const payload = dailyPayload(u.id, row);
  if(payload.claimed) return out(res, 400, { error: '该任务奖励已领取' });
  if(!payload.done) return out(res, 400, { error: '任务尚未完成' });
  const rewards = grantGoalReward(u.id, { chapter: 1, reward_gold: row.reward_gold, reward_items: row.reward_items }, p);
  stmt('INSERT INTO daily_task_claims(user_id,date,slot,claimed_at) VALUES(?,?,?,?)', u.id, today, slot, now());
  return out(res, 200, { ok: true, slot: row.slot, rewards, gold: p.gold, character: buildCharacter(u.id) });
}

/* ========== 随机事件（P2）：触发 / 查询 / 选择结算 ========== */
function randomEventPayload(ev){
  return { id: ev.id, title: ev.title, desc: ev.desc, choices: ev.choices.map(c => c.label) };
}
function pendingEventOf(userId){
  const row = get('SELECT * FROM pending_events WHERE user_id=?', userId);
  if(!row) return null;
  const ev = RANDOM_EVENTS.find(e => e.id === row.event_id);
  if(!ev) return null;
  return { row, ev };
}
/* 战斗胜利 / 副本通关后 20% 触发；已有待处理事件时不重复触发，同时刻至多 1 个 */
function maybeTriggerRandomEvent(userId){
  if(get('SELECT user_id FROM pending_events WHERE user_id=?', userId)) return null;
  if(!rollPct(0.20)) return null;
  const ev = RANDOM_EVENTS[randInt(0, RANDOM_EVENTS.length - 1)];
  stmt('INSERT INTO pending_events(user_id,event_id,created) VALUES(?,?,?)', userId, ev.id, now());
  return randomEventPayload(ev);
}
/* 结算选项效果：金币 / 生命 / 物品 / 装备 / 概率分支；写库并返回明细 */
function applyRandomEventEffects(p, ev, choiceIdx){
  const choice = ev.choices[choiceIdx];
  if(choice.cost != null && p.gold < choice.cost){
    const e = new Error('金币不足，无法选择该选项');
    e.status = 400; throw e;
  }
  const res = { gold: 0, hp: 0, items: [], log: [] };
  const run = (fx) => {
    for(const e of fx || []){
      if(e.type === 'gold'){
        p.gold += e.amount;
        if(p.gold < 0) p.gold = 0;
        res.gold += e.amount;
      } else if(e.type === 'hp'){
        const before = p.cur_hp;
        p.cur_hp = Math.max(1, Math.min(p.max_hp, p.cur_hp + e.amount));
        res.hp += p.cur_hp - before;
      } else if(e.type === 'item'){
        addItem(p.user_id, e.name, e.item_type || 'material', e.quality || 'normal', e.stats || {}, 'backpack', e.quantity || 1);
        res.items.push(e.name + '×' + (e.quantity || 1));
      } else if(e.type === 'equip'){
        const cfg = CHAPTER_CONFIG[p.chapter || 1] || CHAPTER_CONFIG[1];
        const proto = cfg.equip[randInt(0, cfg.equip.length - 1)];
        const q = rollDropQuality('normal', 0, 0) || 'normal';
        addItem(p.user_id, proto.name, proto.type, q, proto.stats, 'backpack', 1);
        res.items.push(proto.name + '（' + q + '）');
      } else if(e.type === 'nothing'){
        if(e.text) res.log.push(e.text);
      } else if(e.type === 'branch'){
        let r = Math.random(), acc = 0, picked = null;
        for(const b of e.branches || []){ acc += b.pct; if(r < acc){ picked = b; break; } }
        if(picked){ run(picked.effects); if(picked.text) res.log.push(picked.text); }
      }
    }
  };
  run(choice.effects);
  stmt('UPDATE player SET gold=?, cur_hp=? WHERE user_id=?', p.gold, p.cur_hp, p.user_id);
  return res;
}
/* GET /api/rpg/events：查询当前是否有待处理事件 */
function handleRandomEvents(req, res, u){
  const pe = pendingEventOf(u.id);
  if(!pe) return out(res, 200, { event: null });
  return out(res, 200, { event: randomEventPayload(pe.ev) });
}
/* POST /api/rpg/events/choose：校验事件存在且未处理，结算并清除 */
async function handleRandomEventChoose(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const pe = pendingEventOf(u.id);
  if(!pe) return out(res, 400, { error: '当前没有待处理事件' });
  if(String(b.event_id || '') !== pe.ev.id) return out(res, 400, { error: '事件不匹配或已处理' });
  const choice = Number(b.choice);
  if(!Number.isInteger(choice) || choice < 1 || choice > pe.ev.choices.length) return out(res, 400, { error: '选项无效' });
  const result = applyRandomEventEffects(p, pe.ev, choice - 1);
  stmt('DELETE FROM pending_events WHERE user_id=?', u.id);
  return out(res, 200, {
    ok: true, event_id: pe.ev.id, ...result,
    gold: p.gold, cur_hp: p.cur_hp,
    character: buildCharacter(u.id), backpack: buildBackpack(u.id)
  });
}

/* 发放奖励：金币直接入账；材料/装备直接入包；装备箱按 box 掉落表 roll 一件装备（与商店开箱一致） */
function grantGoalReward(userId, goal, p){
  const rewards = [];
  if(goal.reward_gold > 0){
    p.gold += goal.reward_gold;
    rewards.push({ kind: 'gold', name: '金币', quantity: goal.reward_gold });
  }
  for(const it of safeJson(goal.reward_items, [])){
    if(it.box){
      const cfg = CHAPTER_CONFIG[goal.chapter] || CHAPTER_CONFIG[1];
      const proto = cfg.equip[randInt(0, cfg.equip.length - 1)];
      const q = rollDropQuality('box', 0, 0) || 'normal';
      addItem(userId, proto.name, proto.type, q, proto.stats, 'backpack', 1);
      rewards.push({ kind: 'equip_box', name: proto.name, type: proto.type, quality: q });
    } else {
      addItem(userId, it.name, it.type || 'material', it.quality || 'normal', it.stats || {}, 'backpack', it.quantity || 1);
      rewards.push({ kind: it.type || 'material', name: it.name, quality: it.quality || 'normal', quantity: it.quantity || 1 });
    }
  }
  stmt('UPDATE player SET gold=? WHERE user_id=?', p.gold, userId);
  return rewards;
}
async function handleChapterGoals(req, res, u){
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const chapter = Number(new URL(req.url, 'http://x').searchParams.get('chapter')) || 0;
  if(chapter && ![1, 2].includes(chapter)) return out(res, 400, { error: '章节无效' });
  return out(res, 200, { goals: listChapterGoals(u.id, chapter || null) });
}
async function handleGoalClaim(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const goalId = Number(b.goal_id) || 0;
  const row = get('SELECT * FROM chapter_goals WHERE id=?', goalId);
  if(!row) return out(res, 404, { error: '目标不存在' });
  const payload = goalPayload(u.id, row);
  if(payload.claimed) return out(res, 400, { error: '该目标奖励已领取' });
  if(!payload.done) return out(res, 400, { error: '目标尚未完成' });
  const rewards = grantGoalReward(u.id, row, p);
  stmt('INSERT INTO goal_claims(user_id,goal_id,claimed_at) VALUES(?,?,?)', u.id, row.id, now());
  return out(res, 200, { ok: true, goal_id: row.id, rewards, gold: p.gold, character: buildCharacter(u.id) });
}

/* ========== 成就（P5）：定义表 / 动态进度 / 解锁 / 领取防重复 ========== */
/* 类型覆盖：level 等级 / dungeon 副本 / boss Boss击杀 / kill 击杀 / collect 装备收集 / trade 交易 / daily 每日任务 / reincarnate 转生 / gold 金币 / encounter 奇遇 */
const ACHIEVEMENTS = [
  { code:'level_5',  type:'level',        name:'初出茅庐', desc:'达到 5 级', amount:5, reward_gold:200, reward_items:[] },
  { code:'level_10', type:'level',        name:'崭露头角', desc:'达到 10 级', amount:10, reward_gold:500, reward_items:[{ box:true }] },
  { code:'level_20', type:'level',        name:'声名鹊起', desc:'达到 20 级', amount:20, reward_gold:1200, reward_items:[{ name:'精炼黑铁', type:'material', quantity:3 }] },
  { code:'level_50', type:'level',        name:'名动一方', desc:'达到 50 级', amount:50, reward_gold:3000, reward_items:[{ box:true }] },
  { code:'level_100',type:'level',        name:'登峰造极', desc:'达到 100 级（满级）', amount:100, reward_gold:10000, reward_items:[{ box:true }] },
  { code:'dungeon_clear_1',  type:'dungeon', name:'初探灰烬森林', desc:'通关任意副本 1 次', amount:1, reward_gold:300, reward_items:[] },
  { code:'dungeon_clear_10', type:'dungeon', name:'副本老手', desc:'通关任意副本 10 次', amount:10, reward_gold:1200, reward_items:[{ box:true }] },
  { code:'dungeon_clear_30', type:'dungeon', name:'副本狂人', desc:'通关任意副本 30 次', amount:30, reward_gold:4000, reward_items:[{ box:true }] },
  { code:'boss_kill_10', type:'boss', name:'狩猎 Boss', desc:'累计击败 Boss 10 次', amount:10, reward_gold:1500, reward_items:[{ name:'黑狼牙', type:'material', quantity:5 }] },
  { code:'kill_100', type:'kill', name:'百人斩', desc:'累计击杀 100 只怪物', amount:100, reward_gold:600, reward_items:[{ box:true }] },
  { code:'kill_500', type:'kill', name:'屠戮者', desc:'累计击杀 500 只怪物', amount:500, reward_gold:2500, reward_items:[{ box:true }] },
  { code:'equip_collect_10', type:'collect', name:'装备收藏家', desc:'拥有 10 件不同装备', amount:10, reward_gold:500, reward_items:[] },
  { code:'equip_collect_30', type:'collect', name:'装备大师', desc:'拥有 30 件不同装备', amount:30, reward_gold:2000, reward_items:[{ box:true }] },
  { code:'trade_1',  type:'trade', name:'初试交易', desc:'完成 1 次交易', amount:1, reward_gold:300, reward_items:[] },
  { code:'trade_10', type:'trade', name:'商贾之路', desc:'完成 10 次交易', amount:10, reward_gold:1200, reward_items:[{ name:'精制皮革', type:'material', quantity:3 }] },
  { code:'daily_7',  type:'daily', name:'七日勤勉', desc:'累计完成 7 个每日任务', amount:7, reward_gold:800, reward_items:[] },
  { code:'daily_30', type:'daily', name:'持之以恒', desc:'累计完成 30 个每日任务', amount:30, reward_gold:3000, reward_items:[{ box:true }] },
  { code:'reincarnate_1', type:'reincarnate', name:'破茧重生', desc:'完成 1 次转生', amount:1, reward_gold:2000, reward_items:[{ box:true }] },
  { code:'gold_hold_10000', type:'gold', name:'富甲一方', desc:'持有 10000 金币', amount:10000, reward_gold:1000, reward_items:[] },
  { code:'encounter_10', type:'encounter', name:'奇遇连连', desc:'累计触发 10 次奇遇', amount:10, reward_gold:300, reward_items:[] }
];
function achievementProgressOf(userId, a){
  const p = getPlayer(userId);
  if(a.type === 'level') return p ? p.level : 0;
  if(a.type === 'dungeon'){
    const r = get('SELECT COUNT(*) AS c FROM dungeon_runs WHERE user_id=? AND win=1', userId);
    return Number(r.c) || 0;
  }
  if(a.type === 'boss'){
    if(!p) return 0;
    return Number(p.boss_kills_ch1 || 0) + Number(p.boss_kills_ch2 || 0);
  }
  if(a.type === 'kill'){
    const r = get('SELECT COALESCE(SUM(count),0) AS c FROM monster_kills WHERE user_id=?', userId);
    return Number(r.c) || 0;
  }
  if(a.type === 'collect'){
    const r = get("SELECT COUNT(DISTINCT name) AS c FROM items WHERE owner_id=? AND type IN ('weapon','armor','accessory')", userId);
    return Number(r.c) || 0;
  }
  if(a.type === 'trade'){
    const r = get('SELECT COUNT(*) AS c FROM market_trades WHERE buyer_id=? OR seller_id=?', userId, userId);
    return Number(r.c) || 0;
  }
  if(a.type === 'daily'){
    const r = get('SELECT COUNT(*) AS c FROM daily_task_claims WHERE user_id=?', userId);
    return Number(r.c) || 0;
  }
  if(a.type === 'reincarnate') return p ? (p.reincarnate_count || 0) : 0;
  if(a.type === 'gold') return p ? p.gold : 0;
  if(a.type === 'encounter'){
    const r = get('SELECT COALESCE(SUM(count),0) AS c FROM encounter_log WHERE user_id=?', userId);
    return Number(r.c) || 0;
  }
  return 0;
}
/* 计算某成就当前进度并自动解锁（首次达标写入 unlocked_at）；成就解锁后不回收，转生降级仍保留已解锁状态 */
function achievementPayload(userId, a){
  const progress = achievementProgressOf(userId, a);
  const done = progress >= a.amount;
  let row = get('SELECT * FROM achievement_progress WHERE user_id=? AND code=?', userId, a.code);
  if(!row && done){
    stmt('INSERT INTO achievement_progress(user_id,code,progress,unlocked_at,claimed_at) VALUES(?,?,?,?,NULL)', userId, a.code, progress, now());
    row = get('SELECT * FROM achievement_progress WHERE user_id=? AND code=?', userId, a.code);
  } else if(row && row.unlocked_at == null && done){
    stmt('UPDATE achievement_progress SET progress=?, unlocked_at=? WHERE user_id=? AND code=?', progress, now(), userId, a.code);
    row = get('SELECT * FROM achievement_progress WHERE user_id=? AND code=?', userId, a.code);
  }
  return {
    code: a.code, type: a.type, name: a.name, desc: a.desc,
    amount: a.amount, reward: { gold: a.reward_gold, items: safeJson(a.reward_items, []) },
    progress, done,
    unlocked: !!(row && row.unlocked_at != null),
    claimed: !!(row && row.claimed_at != null),
    claimable: !!(row && row.unlocked_at != null && row.claimed_at == null)
  };
}
/* GET /api/rpg/achievements：查询全部成就进度与可领取状态 */
function handleAchievements(req, res, u){
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const list = ACHIEVEMENTS.map(a => achievementPayload(u.id, a));
  return out(res, 200, { total: list.length, unlocked: list.filter(x => x.unlocked).length, achievements: list });
}
/* POST /api/rpg/achievements/claim：领取成就奖励（防重复，已领取 400） */
async function handleAchievementClaim(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const a = ACHIEVEMENTS.find(x => x.code === String(b.code || ''));
  if(!a) return out(res, 404, { error: '成就不存在' });
  const pay = achievementPayload(u.id, a);
  if(pay.claimed) return out(res, 400, { error: '该成就奖励已领取' });
  if(!pay.unlocked) return out(res, 400, { error: '成就尚未达成' });
  const rewards = grantGoalReward(u.id, { chapter: 1, reward_gold: a.reward_gold, reward_items: a.reward_items }, p);
  stmt('UPDATE achievement_progress SET claimed_at=? WHERE user_id=? AND code=?', now(), u.id, a.code);
  return out(res, 200, { ok: true, code: a.code, rewards, gold: p.gold, character: buildCharacter(u.id) });
}

/* ========== 排行榜（P5）：战力 / 等级 / 副本三榜 Top20 ========== */
/* GET /api/rpg/leaderboard?type=power|level|dungeon */
function handleLeaderboard(req, res, u){
  const type = new URL(req.url, 'http://x').searchParams.get('type') || 'power';
  let rows = [];
  if(type === 'power'){
    const players = all('SELECT user_id FROM player');
    rows = players.map(pl => {
      const p = getPlayer(pl.user_id);
      const st = computeStats(p, getPlayerItems(pl.user_id));
      const un = get('SELECT username, display_name FROM users WHERE id=?', pl.user_id);
      return { user_id: pl.user_id, username: (un && (un.display_name || un.username)) || '?', value: st ? st.power : 0 };
    }).sort((a, b) => b.value - a.value).slice(0, 20);
  } else if(type === 'level'){
    rows = all(`SELECT p.user_id, u.username, u.display_name, p.level, p.exp FROM player p JOIN users u ON u.id=p.user_id ORDER BY p.level DESC, p.exp DESC LIMIT 20`)
      .map(r => ({ user_id: r.user_id, username: r.display_name || r.username, value: r.level, level: r.level, exp: r.exp }));
  } else if(type === 'dungeon'){
    rows = all(`SELECT d.user_id, u.username, u.display_name, COUNT(*) AS clears FROM dungeon_runs d JOIN users u ON u.id=d.user_id WHERE d.win=1 GROUP BY d.user_id ORDER BY clears DESC LIMIT 20`)
      .map(r => ({ user_id: r.user_id, username: r.display_name || r.username, value: r.clears, clears: r.clears }));
  } else {
    return out(res, 400, { error: '排行榜类型无效，可选 power / level / dungeon' });
  }
  const entries = rows.map((x, i) => ({ ...x, rank: i + 1 }));
  return out(res, 200, { type, entries });
}

/* ========== 转生（P5）：满级校验 / 等级重置 / 永久加成 / 称号记录 ========== */
/* POST /api/rpg/reincarnate：100 级可转生，等级重置 1、exp 清空，属性恢复 1 级基础并叠加永久加成，转生次数 +1 */
function handleReincarnate(req, res, u){
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  if(p.level < MAX_LEVEL) return out(res, 400, { error: '未满 100 级无法转生' });
  const n = (p.reincarnate_count || 0) + 1;
  /* 加成随转生次数递增：第 n 次 +hp(40+10n) / +atk(6+2n) / +def(3+n) / +crit(1) */
  const gainHp = 40 + n * 10, gainAtk = 6 + n * 2, gainDef = 3 + n, gainCrit = 1;
  const newMaxHp = INIT_STATS.max_hp + (p.reincarnate_bonus_hp || 0) + gainHp;
  const newAtk = INIT_STATS.attack + (p.reincarnate_bonus_atk || 0) + gainAtk;
  const newDef = INIT_STATS.defense + (p.reincarnate_bonus_def || 0) + gainDef;
  const newCrit = INIT_STATS.crit_rate + (p.reincarnate_bonus_crit || 0) + gainCrit;
  stmt('UPDATE player SET level=1, exp=0, max_hp=?, cur_hp=?, attack=?, defense=?, crit_rate=?, reincarnate_count=?, reincarnate_title=?, reincarnate_bonus_hp=?, reincarnate_bonus_atk=?, reincarnate_bonus_def=?, reincarnate_bonus_crit=? WHERE user_id=?',
    newMaxHp, newMaxHp, newAtk, newDef, newCrit, n, reincarnateTitle(n),
    (p.reincarnate_bonus_hp || 0) + gainHp, (p.reincarnate_bonus_atk || 0) + gainAtk,
    (p.reincarnate_bonus_def || 0) + gainDef, (p.reincarnate_bonus_crit || 0) + gainCrit, u.id);
  return out(res, 200, {
    ok: true, reincarnate_count: n, title: reincarnateTitle(n),
    gained: { max_hp: gainHp, attack: gainAtk, defense: gainDef, crit_rate: gainCrit },
    character: buildCharacter(u.id)
  });
}

/* 掉落品质 roll：tableKey 掉落表 + bonusPct(精灵加成加到普通档) + boost(品质升档，最高稀有) */
function rollDropQuality(tableKey, bonusPct, boost){
  bonusPct = bonusPct || 0; boost = boost || 0;
  const table = DROP_TABLE[tableKey] || DROP_TABLE.normal;
  let total = 0;
  for(const q of QUALITY_ORDER) total += (table[q] || 0);
  total += bonusPct / 100;
  let r = Math.random() * total;
  let pick = null;
  for(const q of QUALITY_ORDER){
    r -= (table[q] || 0) + (q === 'normal' ? bonusPct / 100 : 0);
    if(r <= 0){ pick = q; break; }
  }
  if(!pick) return null;
  const idx = Math.min(4, QUALITY_ORDER.indexOf(pick) + boost);
  return QUALITY_ORDER[idx];
}

/* 战斗胜利奖励：经验 / 金币(含金币加成) / 装备与材料掉落 */
function grantBattleRewards(playerRow, monsterKey, tier, cfg){
  const monster = MONSTER_CONFIG[monsterKey];
  const items = getPlayerItems(playerRow.user_id);
  const stats = computeStats(playerRow, items);
  const eq = items.filter(it => it.location.startsWith('equipped_'));
  const eqSum = key => eq.reduce((t, it) => t + (Number(it.stats[key]) || 0), 0);
  const race = RACE_CONFIG[playerRow.race] || {};
  const gold = randInt(monster.gold[0], monster.gold[1]);
  const goldGain = Math.max(1, Math.floor(gold * (1 + stats.gold_bonus / 100)));
  /* P5 长线养成：等级越高经验效率越高（10 级起每 10 级 ×1 倍，满级 ×10），保证 1-100 曲线在合理场次内可达 */
  const expScale = Math.max(1, Math.floor(playerRow.level / 10));
  const expGain = Math.floor(monster.exp * expScale);
  const drops = [];
  let bonusPct = 0;
  if(tier === 'normal' || tier === 'elite') bonusPct += (race.drop_bonus || 0);
  const dropKey = tier === 'normal' ? 'normal' : tier === 'elite' ? 'elite' : cfg.drop;
  const boost = tier === 'boss' ? (cfg.bossBoost || 0) : 0;
  const q = rollDropQuality(dropKey, bonusPct, boost);
  if(q){
    const proto = cfg.equip[randInt(0, cfg.equip.length - 1)];
    addItem(playerRow.user_id, proto.name, proto.type, q, proto.stats, 'backpack', 1);
    drops.push({ name: proto.name, type: proto.type, quality: q });
  }
  const mats = [];
  if(tier === 'normal') mats.push(cfg.normal_mat[randInt(0, cfg.normal_mat.length - 1)]);
  if(tier === 'elite'){ mats.push('黑狼牙'); mats.push(cfg.normal_mat[0]); }
  if(tier === 'boss'){ mats.push('黑狼牙'); mats.push('黑狼牙'); mats.push(cfg.normal_mat[0]); }
  for(const mn of mats){
    addItem(playerRow.user_id, mn, 'material', 'normal', {}, 'backpack', 1);
    drops.push({ name: mn, type: 'material', quality: 'normal' });
  }
  return { gold: goldGain, exp: expGain, drops };
}

/* 经验与升级：经验需求按 expNeedFor 曲线递增（1-100 级，P5），每级 hp+20/atk+3/def+1 */
function applyExpAndLevel(playerRow, expGain){
  let level = playerRow.level, exp = playerRow.exp + expGain, ups = 0;
  while(level < MAX_LEVEL && exp >= expNeedFor(level)){
    exp -= expNeedFor(level); level++;
    playerRow.max_hp += LEVEL_UP_GROWTH.max_hp;
    playerRow.attack += LEVEL_UP_GROWTH.attack;
    playerRow.defense += LEVEL_UP_GROWTH.defense;
    ups++;
  }
  let curHp = playerRow.cur_hp;
  if(ups > 0){
    // 升级立即回满血（含装备/种族加成的满血），写库保证面板与后续战斗按满血继续
    curHp = computeStats(playerRow, getPlayerItems(playerRow.user_id)).max_hp;
    playerRow.cur_hp = curHp;
  }
  stmt('UPDATE player SET exp=?, level=?, max_hp=?, attack=?, defense=?, cur_hp=? WHERE user_id=?', exp, level, playerRow.max_hp, playerRow.attack, playerRow.defense, curHp, playerRow.user_id);
  playerRow.level = level; playerRow.exp = exp;
  return ups;
}

/* 自动战斗模拟：玩家攻击→怪物攻击→判断生命→自动药水→下一回合 */
function simulateBattle(playerRow, monsterKey, opts){
  opts = opts || {};
  const items = getPlayerItems(playerRow.user_id);
  const stats = computeStats(playerRow, items);
  const eq = items.filter(it => it.location.startsWith('equipped_'));
  const eqSum = key => eq.reduce((t, it) => t + (Number(it.stats[key]) || 0), 0);
  const race = RACE_CONFIG[playerRow.race] || {};
  const monster = MONSTER_CONFIG[monsterKey];
  if(!monster) throw Error('未知怪物');
  const m = { hp: monster.hp, maxHp: monster.hp, atk: monster.attack, def: monster.defense };
  const pb = { atkMulNext: 1, noCritNext: false, shieldReduceNext: false, defDown: 0, defDownT: 0, curse: 0, curseT: 0, bleed: 0, bleedT: 0, healUsed: 0 };
  const mb = { armor: 0, armorUses: 0, turns: 0, hitCount: 0, healUsed: false, summonUsed: false };
  const log = [];
  const hpTrace = [];
  const traceHp = () => hpTrace.push({ p: Math.max(0, stats.cur_hp), pm: stats.max_hp, m: Math.max(0, m.hp), mm: m.maxHp });
  traceHp();
  const potionCfg = {
    enabled: opts.autoPotion !== false,
    threshold: opts.potionThreshold != null ? opts.potionThreshold : (playerRow.potion_threshold != null ? playerRow.potion_threshold : 35),
    limit: opts.potionLimit != null ? opts.potionLimit : (playerRow.potion_limit != null ? playerRow.potion_limit : 1)
  };
  const potionItems = items.filter(it => it.type === 'consumable' && it.location === 'backpack' && it.stats && it.stats.heal_pct);
  const usePotion = () => {
    if(pb.healUsed >= potionCfg.limit || !potionItems.length) return false;
    potionItems.sort((a, b) => (b.stats.heal_pct || 0) - (a.stats.heal_pct || 0));
    const pot = potionItems[0];
    if(!pot) return false;
    let heal = Math.floor(stats.max_hp * (pot.stats.heal_pct / 100));
    const before = stats.cur_hp;
    stats.cur_hp = Math.min(stats.max_hp, stats.cur_hp + heal);
    pb.healUsed++;
    consumeItem(playerRow.user_id, pot.id, 1);
    log.push('自动使用' + pot.name + '，恢复 ' + (stats.cur_hp - before) + ' 点生命');
    return true;
  };
  const playerAttack = () => {
    let atk = stats.attack + (pb.curse || 0);
    let crit = rollPct(stats.crit_rate / 100);
    if(pb.noCritNext) crit = false;
    let dmg = calcAttackDamage({ attack: atk, crit_dmg: stats.crit_dmg }, m.def + mb.armor, { crit, reducers: [] });
    if(pb.atkMulNext < 1) dmg = Math.max(1, Math.floor(dmg * pb.atkMulNext));
    if(pb.shieldReduceNext) dmg = Math.max(1, Math.floor(dmg * (1 - 0.30)));
    if(eqSum('beast_hp_low_dmg') && m.hp < m.maxHp / 2) dmg += eqSum('beast_hp_low_dmg');
    pb.atkMulNext = 1; pb.noCritNext = false; pb.shieldReduceNext = false;
    const wasCrit = crit;
    m.hp -= dmg;
    mb.hitCount++;
    log.push('第' + mb.turns + '回合 你攻击造成 ' + dmg + ' 伤害' + (wasCrit ? '（暴击）' : ''));
    if(wasCrit && monster.crit_counter){
      stats.cur_hp -= monster.crit_counter;
      log.push('敌人反弹暴击，你受到 ' + monster.crit_counter + ' 点伤害');
    }
    if(monster.armor_on_hit_every && mb.hitCount % monster.armor_on_hit_every === 0 && mb.armorUses < monster.armor_on_hit_max){
      mb.armor += monster.armor_on_hit_amt;
      mb.armorUses++;
      log.push('敌人受击硬化，防御 +' + monster.armor_on_hit_amt);
    }
    return dmg;
  };
  const monsterAttack = () => {
    let atk = m.atk;
    if(mb.turns === 1 && monster.first_turn_atk) atk += monster.first_turn_atk;
    let crit = false;
    if(monster.enrage_hp && m.hp < m.maxHp * monster.enrage_hp){
      atk += (monster.enrage_atk || 0);
      if(monster.enrage_crit) crit = rollPct(monster.enrage_crit / 100);
    }
    if(monster.frenzy_hp && m.hp < m.maxHp * monster.frenzy_hp) atk += (monster.frenzy_atk || 0);
    if(monster.curse && mb.turns === 1){
      pb.curse = monster.curse.atk; pb.curseT = monster.curse.dur;
      log.push('敌人施加诅咒，你的攻击 -' + Math.abs(monster.curse.atk));
    }
    if(monster.heal_hp && m.hp < m.maxHp * monster.heal_hp && !mb.healUsed){
      m.hp = Math.min(m.maxHp, m.hp + monster.heal_amt); mb.healUsed = true;
      log.push('敌人恢复 ' + monster.heal_amt + ' 点生命');
    }
    if(monster.summon_hp && m.hp < m.maxHp * monster.summon_hp && !mb.summonUsed){
      mb.summonUsed = true;
      log.push('敌人召唤援军，所受伤害降低');
    }
    const reducers = [];
    if(race.boss_dmg_reduce) reducers.push(race.boss_dmg_reduce);
    if(monster.kind === '野兽' && eqSum('beast_dmg_reduce')) reducers.push(eqSum('beast_dmg_reduce'));
    if(monster.kind === '黑雾' && eqSum('undead_dmg')) reducers.push(0);
    if(mb.summonUsed && monster.summon_reduce) reducers.push(monster.summon_reduce);
    if(opts.monsterAtkBonus) atk += opts.monsterAtkBonus;
    const def = Math.max(0, stats.defense - (pb.defDown || 0));
    let dmg = calcAttackDamage({ attack: atk, crit_dmg: 150 }, def, { crit, reducers });
    let rend = false;
    if(monster.rend_every && mb.turns % monster.rend_every === 0){
      rend = true;
      dmg = Math.max(1, Math.floor(dmg * monster.rend_mult));
      if(monster.bleed_pct && rollPct(monster.bleed_pct)){
        pb.bleed = monster.bleed_dmg; pb.bleedT = monster.bleed_dur;
        log.push('敌人撕裂攻击，你陷入流血状态');
      }
    }
    if(monster.shield_extra) dmg += monster.shield_extra;
    if(monster.frenzy_hp && m.hp < m.maxHp * monster.frenzy_hp && monster.frenzy_dot) dmg += monster.frenzy_dot;
    stats.cur_hp -= dmg;
    log.push('第' + mb.turns + '回合 敌人攻击造成 ' + dmg + ' 伤害' + (rend ? '（撕裂）' : ''));
    if(pb.bleedT > 0){
      stats.cur_hp -= pb.bleed;
      log.push('流血造成 ' + pb.bleed + ' 伤害');
    }
    if(monster.no_crit_next && rollPct(monster.no_crit_next.pct)){
      pb.noCritNext = true;
      log.push('敌人干扰，你下一次攻击无法暴击');
    }
    if(monster.atk_down_next && rollPct(monster.atk_down_next.pct)){
      pb.atkMulNext = 1 - monster.atk_down_next.pct;
      log.push('敌人削弱，你下一次攻击伤害 -' + Math.round(monster.atk_down_next.pct * 100) + '%');
    }
    if(monster.shield_next_reduce && rollPct(1)) pb.shieldReduceNext = true;
    return dmg;
  };

  while(mb.turns < MAX_BATTLE_TURNS){
    mb.turns++;
    playerAttack();
    if(m.hp <= 0) break;
    monsterAttack();
    if(stats.cur_hp <= 0){ stats.cur_hp = 0; break; }
    if(potionCfg.enabled && stats.cur_hp < stats.max_hp * potionCfg.threshold / 100) usePotion();
    if(stats.cur_hp <= 0){ stats.cur_hp = 0; break; }
    if(pb.defDownT > 0){ if(--pb.defDownT === 0) pb.defDown = 0; }
    if(pb.curseT > 0){ if(--pb.curseT === 0) pb.curse = 0; }
    if(pb.bleedT > 0) pb.bleedT--;
    if(monster.armor_break_every && mb.turns % monster.armor_break_every === 0){
      pb.defDown = Math.max(pb.defDown, monster.armor_break_amt);
      pb.defDownT = monster.armor_break_dur;
      log.push('敌人破甲，你的防御降低 ' + monster.armor_break_amt + ' 点');
    }
    traceHp();
  }
  traceHp();
  const win = m.hp <= 0;
  stats.cur_hp = Math.max(0, Math.min(stats.max_hp, stats.cur_hp));
  stmt('UPDATE player SET cur_hp=? WHERE user_id=?', stats.cur_hp, playerRow.user_id);
  return { win, curHp: stats.cur_hp, turns: mb.turns, log, hpTrace, healUsed: pb.healUsed };
}

/* 副本事件生成：4格，至少1普通战斗+至少1非战斗，精英25%，Boss固定第4格 */
function rollDungeonSlot(){
  const r = Math.random();
  if(r < 0.45) return { type: 'fight', tier: 'normal' };
  if(r < 0.70) return { type: 'fight', tier: 'elite' };
  return { type: 'encounter' };
}
function generateDungeonEvents(chapter, bossRate){
  const cfg = CHAPTER_CONFIG[chapter];
  const slots = [rollDungeonSlot(), rollDungeonSlot(), rollDungeonSlot()];
  slots.push(rollPct(bossRate || 0.35) ? { type: 'fight', tier: 'boss' } : rollDungeonSlot());
  let nNormal = slots.filter(s => s.type === 'fight' && s.tier === 'normal').length;
  let nEnc = slots.filter(s => s.type === 'encounter').length;
  if(nNormal === 0){
    const idx = slots.findIndex(s => s.type === 'fight' && s.tier === 'elite');
    if(idx >= 0){ slots[idx].tier = 'normal'; nNormal++; }
    else if(nEnc > 0){ slots[slots.findIndex(s => s.type === 'encounter')] = { type: 'fight', tier: 'normal' }; nNormal++; nEnc--; }
    else { slots[0] = { type: 'fight', tier: 'normal' }; nNormal++; }
  }
  if(nEnc === 0){
    const idx = slots.findIndex(s => s.type === 'fight' && s.tier === 'normal');
    if(idx >= 0) slots[idx] = { type: 'encounter' };
    else slots[0] = { type: 'encounter' };
  }
  const encPool = shuffleArr([...cfg.encounters]);
  let encIdx = 0;
  const events = [];
  for(let i = 0; i < 4; i++){
    const s = slots[i];
    if(s.type === 'fight'){
      const mk = s.tier === 'normal' ? cfg.normal[randInt(0, cfg.normal.length - 1)] : s.tier === 'elite' ? cfg.elite[0] : cfg.boss;
      events.push({ slot: i + 1, type: 'fight', tier: s.tier, monster: mk, name: mk, desc: '遭遇' + mk });
    } else {
      const en = encPool[encIdx++ % encPool.length];
      const ec = ENCOUNTER_CONFIG[en];
      const ev = { slot: i + 1, type: 'encounter', name: en, desc: ec.desc, choices: ec.choices };
      if(en === '地底商人'){
        const goods = shuffleArr([...MERCHANT_GOODS]).slice(0, 3);
        ev.merchantGoods = goods;
        ev.choices = goods.map(g => '购买「' + g.name + '」（' + g.price + '金币）');
      }
      events.push(ev);
    }
  }
  return { events, hasBoss: slots.some(s => s.tier === 'boss') };
}

/* 奇遇处理 */
function handleEncounter(playerRow, ev, choice, session){
  const res = { log: [], gold: 0, hp: 0, items: [] };
  if(ev.name === '采药人'){
    if(choice === 2){
      playerRow.gold += 15; res.gold = 15;
      session.nextMonsterAtkBonus += 3;
      res.log.push('索要药材：获得15金币，但下场敌人攻击+3');
    } else {
      playerRow.cur_hp = Math.min(playerRow.max_hp, playerRow.cur_hp + 15); res.hp = 15;
      addItem(playerRow.user_id, '小型药水', 'consumable', 'normal', { heal_pct: 30 }, 'backpack', 1);
      res.items.push('小型药水×1');
      res.log.push('帮助采药人：恢复15点生命并获得小型药水');
    }
  } else if(ev.name === '神秘树洞'){
    if(choice === 1){
      if(rollPct(0.60)){
        playerRow.gold += 20; res.gold = 20;
        res.log.push('树洞中藏着金币：获得20金币');
      } else {
        playerRow.cur_hp = Math.max(1, playerRow.cur_hp - 15); res.hp = -15;
        res.log.push('树洞中蹿出毒虫：受到15点伤害');
      }
    } else {
      const accPool = (CHAPTER_CONFIG[playerRow.chapter || 1].equip || []).filter(x => x.type === 'accessory');
      const proto = accPool.length ? accPool[randInt(0, accPool.length - 1)] : { name: '猎人护符', type: 'accessory', stats: { crit_rate: 5 } };
      addItem(playerRow.user_id, proto.name, proto.type, 'normal', proto.stats, 'backpack', 1);
      res.items.push(proto.name + '（普通）');
      res.log.push('仔细搜索树洞：获得一件普通饰品');
    }
  } else if(ev.name === '猎人营地'){
    const g = randInt(5, 15);
    playerRow.gold += g; res.gold = g;
    addItem(playerRow.user_id, '粗糙皮革', 'material', 'normal', {}, 'backpack', 1);
    res.items.push('粗糙皮革×1');
    if(rollPct(0.20)){
      addItem(playerRow.user_id, '猎人旧地图', 'quest', 'normal', {}, 'backpack', 1);
      res.items.push('猎人旧地图×1');
      res.log.push('搜刮猎人营地：获得 ' + g + ' 金币与粗糙皮革，还发现一张猎人旧地图！');
    } else {
      res.log.push('搜刮猎人营地：获得 ' + g + ' 金币与粗糙皮革');
    }
  } else if(ev.name === '被困矿工'){
    if(choice === 2){
      addItem(playerRow.user_id, '黑铁矿', 'material', 'normal', {}, 'backpack', 1);
      res.items.push('黑铁矿×1');
      res.log.push('搜刮矿工遗物：获得黑铁矿，但下场敌人防御+3');
    } else {
      playerRow.cur_hp = Math.max(1, playerRow.cur_hp - 10); res.hp = -10;
      playerRow.gold += 40; res.gold = 40;
      res.log.push('救出矿工：损失10生命，获得40金币');
    }
  } else if(ev.name === '黑雾祭坛'){
    if(choice === 1){
      playerRow.cur_hp = Math.max(1, playerRow.cur_hp - 20); res.hp = -20;
      addItem(playerRow.user_id, '净化碎片', 'material', 'normal', {}, 'backpack', 1);
      res.items.push('净化碎片×1');
      res.log.push('摧毁祭坛：损失20生命，获得净化碎片');
    } else if(choice === 3){
      playerRow.cur_hp = Math.min(playerRow.max_hp, playerRow.cur_hp + 20); res.hp = 20;
      session.nextForceElite = true;
      res.log.push('向祭坛祈祷：恢复20生命，但下场必为精英战');
    } else {
      res.log.push('研究祭坛：获得临时强化（50%概率获得诅咒）');
      if(rollPct(0.50)) res.log.push('研究失败：你被诅咒了');
    }
  } else if(ev.name === '地底商人'){
    const goods = ev.merchantGoods || [];
    const g = goods[choice - 1];
    if(!g) throw Error('无效选择');
    if(playerRow.gold < g.price) throw Error('金币不足，无法购买');
    playerRow.gold -= g.price;
    addItem(playerRow.user_id, g.name, g.type, g.quality, g.stats || {}, 'backpack', 1);
    res.items.push(g.name + '×1');
    res.gold = -g.price;
    res.log.push('从地底商人处购得 ' + g.name + '，花费 ' + g.price + ' 金币（每局仅此一次）');
  } else {
    res.log.push('奇遇「' + ev.name + '」发生');
  }
  stmt('UPDATE player SET gold=?, cur_hp=? WHERE user_id=?', playerRow.gold, Math.max(0, playerRow.cur_hp), playerRow.user_id);
  return res;
}

async function handleDungeonStart(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  if(dungeonSessions.has(u.id)) return out(res, 400, { error: '副本进行中，请先结算当前副本' });
  const today = localDateStr();
  if(p.last_dungeon_date !== today){ p.daily_count = 0; p.last_dungeon_date = today; }
  if(p.daily_count >= DUNGEON_DAILY_LIMIT) return out(res, 400, { error: '今日副本次数已用完' });
  let chapter = Number(b.chapter) || p.chapter;
  if(![1, 2].includes(chapter)) return out(res, 400, { error: '章节无效' });
  if(chapter === 2 && !(p.level >= 3 && p.boss_kills_ch1 >= 1)) return out(res, 403, { error: '第二章未解锁：需要等级≥3且击败第一章Boss至少1次' });
  const oldMap = hasAndConsumeOldMap(u.id);
  const bossRate = oldMap ? 0.55 : 0.35;
  const gen = generateDungeonEvents(chapter, bossRate);
  const session = { chapter, events: gen.events, idx: 0, startedAt: now(), potionsUsed: 0, exp: 0, gold: 0, drops: [], bossKilled: false, failed: false, failedAt: null, nextMonsterAtkBonus: 0, bossBoost: oldMap ? 1 : 0, oldMap, battleLogs: [], nextForceElite: false };
  dungeonSessions.set(u.id, session);
  const fullHp = computeStats(p, getPlayerItems(u.id)).max_hp;
  p.daily_count++; p.last_dungeon_date = today; p.cur_hp = fullHp;
  stmt('UPDATE player SET daily_count=?, last_dungeon_date=?, cur_hp=? WHERE user_id=?', p.daily_count, today, fullHp, u.id);
  const remaining = DUNGEON_DAILY_LIMIT - p.daily_count;
  return out(res, 201, { ok: true, chapter, remaining, old_map_used: oldMap, events: gen.events.map(e => ({ slot: e.slot, type: e.type, name: e.name, desc: e.desc, choices: e.choices })) });
}

async function handleDungeonEvent(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const s = dungeonSessions.get(u.id);
  if(!s) return out(res, 400, { error: '没有进行中的副本' });
  if(s.idx >= s.events.length) return out(res, 400, { error: '副本已结束，请结算' });
  const ev = s.events[s.idx];
  if(ev.type === 'fight'){
    const battle = simulateBattle(p, ev.monster, {
      autoPotion: p.auto_potion !== 0,
      potionThreshold: p.potion_threshold,
      potionLimit: p.potion_limit,
      monsterAtkBonus: s.nextMonsterAtkBonus,
      bossBoost: s.bossBoost
    });
    s.potionsUsed += battle.healUsed;
    s.battleLogs.push({ event: ev.slot, monster: ev.monster, win: battle.win, log: battle.log });
    if(battle.win){
      const cfg = CHAPTER_CONFIG[s.chapter];
      cfg.bossBoost = s.bossBoost;
      const rewards = grantBattleRewards(p, ev.monster, ev.tier, cfg);
      cfg.bossBoost = 0;
      s.exp += rewards.exp; s.gold += rewards.gold; s.drops.push(...rewards.drops);
      const ups = applyExpAndLevel(p, rewards.exp);
      p.gold += rewards.gold;
      stmt('UPDATE player SET gold=? WHERE user_id=?', p.gold, u.id);
      recordMonsterKill(u.id, ev.monster);
      if(ev.tier === 'boss'){
        s.bossKilled = true;
        if(s.chapter === 2){
          stmt('UPDATE player SET boss_kills_ch2=boss_kills_ch2+1 WHERE user_id=?', u.id);
          p.boss_kills_ch2++;
        } else {
          stmt('UPDATE player SET boss_kills_ch1=boss_kills_ch1+1 WHERE user_id=?', u.id);
          p.boss_kills_ch1++;
        }
      }
      s.idx++;
      const done = s.idx >= s.events.length;
      const rnd = maybeTriggerRandomEvent(u.id);
      return out(res, 200, { ok: true, win: true, monster: ev.monster, tier: ev.tier, exp: rewards.exp, gold: rewards.gold, drops: rewards.drops, healUsed: battle.healUsed, cur_hp: ups > 0 ? p.cur_hp : battle.curHp, level: p.level, log: battle.log, hpTrace: battle.hpTrace, playerName: u.display_name || u.username, remaining_events: s.events.length - s.idx, finished: done, random_event: rnd });
    }
    const lossRate = raceFailGoldLoss(p.race);
    const loss = Math.floor(p.gold * lossRate);
    p.gold = Math.max(0, p.gold - loss);
    stmt('UPDATE player SET gold=? WHERE user_id=?', p.gold, u.id);
    s.failed = true; s.failedAt = ev.slot; s.idx = s.events.length;
    const fullHp = computeStats(p, getPlayerItems(u.id)).max_hp;
    p.cur_hp = fullHp;
    stmt('UPDATE player SET cur_hp=? WHERE user_id=?', fullHp, u.id);
    return out(res, 200, { ok: true, win: false, monster: ev.monster, gold_loss: loss, cur_hp: fullHp, log: battle.log, hpTrace: battle.hpTrace, playerName: u.display_name || u.username, finished: true, failed: true });
  }
  const choice = Number(b.choice) || 1;
  const r = handleEncounter(p, ev, choice, s);
  if (r.gold) s.gold += r.gold;
  recordEncounter(u.id, ev.name);
  s.idx++;
  const done = s.idx >= s.events.length;
  return out(res, 200, { ok: true, encounter: ev.name, choice, log: r.log, gold: r.gold, hp: r.hp, items: r.items, remaining_events: s.events.length - s.idx, finished: done });
}

function handleDungeonSettle(req, res, u){
  const s = dungeonSessions.get(u.id);
  if(!s) return out(res, 400, { error: '没有进行中的副本' });
  dungeonSessions.delete(u.id);
  const p = getPlayer(u.id);
  if(p){
    const fullHp = computeStats(p, getPlayerItems(u.id)).max_hp;
    stmt('UPDATE player SET cur_hp=? WHERE user_id=?', fullHp, u.id);
  }
  const completedEvents = Math.min(s.idx, s.events.length);
  const cleared = !s.failed && completedEvents >= s.events.length;
  /* P3：副本通关必掉 1 件装备（品质随层数提升）；战斗中已掉装备则不重复补 */
  if(cleared && !s.drops.some(d => ['weapon','armor','accessory'].includes(d.type))){
    const cfg = CHAPTER_CONFIG[s.chapter] || CHAPTER_CONFIG[1];
    const proto = cfg.equip[randInt(0, cfg.equip.length - 1)];
    const q = rollDropQuality(s.chapter >= 2 ? 'boss1' : 'box', 0, 0) || 'normal';
    addItem(u.id, proto.name, proto.type, q, proto.stats, 'backpack', 1);
    s.drops.push({ name: proto.name, type: proto.type, quality: q, quantity: 1, guaranteed: true });
  }
  recordDungeonRun(u.id, s.chapter, cleared);
  const rnd = cleared ? maybeTriggerRandomEvent(u.id) : null;
  return out(res, 200, {
    ok: true, chapter: s.chapter, total_events: s.events.length, completed_events: completedEvents,
    boss_killed: s.bossKilled, failed: s.failed, failed_at: s.failedAt, exp: s.exp, gold: s.gold,
    drops: s.drops, potions_used: s.potionsUsed, old_map_used: s.oldMap, battles: s.battleLogs,
    random_event: rnd
  });
}

function handleDungeonStatus(req, res, u){
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const today = localDateStr();
  const used = p.last_dungeon_date === today ? p.daily_count : 0;
  const s = dungeonSessions.get(u.id);
  return out(res, 200, {
    remaining: Math.max(0, DUNGEON_DAILY_LIMIT - used), daily_used: used,
    chapter: p.chapter, level: p.level, boss_kills_ch1: p.boss_kills_ch1, boss_kills_ch2: p.boss_kills_ch2,
    ch2_unlocked: p.level >= 3 && p.boss_kills_ch1 >= 1,
    auto_potion: { enabled: p.auto_potion !== 0, threshold: p.potion_threshold != null ? p.potion_threshold : 35, limit: p.potion_limit != null ? p.potion_limit : 1 },
    in_dungeon: !!s, dungeon_progress: s ? { chapter: s.chapter, next_slot: s.idx + 1, total: s.events.length, finished: s.idx >= s.events.length, failed: s.failed } : null
  });
}

/* 副本信息：章节掉落与概率、可触发剧情（副本选择详情页） */
function handleDungeonInfo(req, res, u){
  const chapter = Number(new URL(req.url, 'http://x').searchParams.get('chapter')) || 1;
  const cfg = CHAPTER_CONFIG[chapter];
  if(!cfg) return out(res, 404, { error: '章节不存在' });
  const qcn = { normal: '普通', fine: '优良', superb: '精良', rare: '稀有', legendary: '传说' };
  const pct = n => (n * 100).toFixed(n >= 0.1 ? 0 : 1) + '%';
  const equipNames = cfg.equip.map(e => e.name).slice(0, 3).join('、');
  const tierDrop = (tierKey, label) => {
    const t = DROP_TABLE[tierKey];
    return { name: label, items: Object.entries(t).map(([q, v]) => ({ name: qcn[q], rate: pct(v) })).concat([{ name: '装备池', rate: '—', note: equipNames + ' 等' }]) };
  };
  const drops = [
    tierDrop('normal', '普通战斗'),
    tierDrop('elite', '精英战斗'),
    tierDrop(cfg.drop, 'Boss战（' + cfg.boss + '）'),
    { name: '通关必掉', items: [{ name: chapter >= 2 ? '优良以上品质装备' : '装备（品质随层数提升）', rate: '必定掉落', note: '通关结算必得 1 件' }] },
    { name: '材料掉落', items: [
      { name: cfg.normal_mat[0] + ' 等', rate: '必定掉落', note: '普通战必得 1 份' },
      { name: '黑狼牙', rate: '精英/Boss 必得', note: '' }
    ]}
  ];
  const encounters = cfg.encounters.map(n => ({ name: n, desc: (ENCOUNTER_CONFIG[n] || {}).desc || '' }));
  return out(res, 200, { chapter, name: cfg.name, monsters: cfg.normal.concat(cfg.elite, [cfg.boss]).map(k => ({ name: k, tier: MONSTER_CONFIG[k].tier })), drops, encounters });
}

async function handleDungeonSettings(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const enabled = typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : p.auto_potion;
  let threshold = Number(b.threshold);
  if(!Number.isFinite(threshold)) threshold = p.potion_threshold != null ? p.potion_threshold : 35;
  threshold = Math.max(1, Math.min(99, threshold));
  let limit = Number(b.limit);
  if(!Number.isFinite(limit)) limit = p.potion_limit != null ? p.potion_limit : 1;
  limit = Math.max(0, Math.min(10, limit));
  stmt('UPDATE player SET auto_potion=?, potion_threshold=?, potion_limit=? WHERE user_id=?', enabled, threshold, limit, u.id);
  return out(res, 200, { ok: true, auto_potion: { enabled: !!enabled, threshold, limit } });
}

/* ========== 阶段3：铁匠铺 / 商店 / 交易行（第 7 节） ========== */
function ownedMaterialMap(uId){
  const m = {};
  for(const r of all('SELECT name, SUM(quantity) AS q FROM items WHERE owner_id=? AND type=? AND location=? GROUP BY name', uId, 'material', 'backpack'))
    m[r.name] = Number(r.q);
  return m;
}
function forgeCatalog(uId){
  const p = uId ? getPlayer(uId) : null;
  const owned = uId ? ownedMaterialMap(uId) : {};
  const gold = p ? p.gold : 0;
  const decorate = (name, r, kind, extra) => {
    let maxCraftable = Infinity;
    const ownedIngredients = {}, missingIngredients = {};
    for(const [mn, qty] of Object.entries(r.ingredients || {})){
      const have = owned[mn] || 0;
      ownedIngredients[mn] = have;
      if(have < qty) missingIngredients[mn] = qty - have;
      const lim = Math.floor(have / qty);
      if(lim < maxCraftable) maxCraftable = lim;
    }
    const goldLim = Math.floor(gold / r.cost);
    if(goldLim < maxCraftable) maxCraftable = goldLim;
    if(!Number.isFinite(maxCraftable) || maxCraftable < 0) maxCraftable = 0;
    const unlocked = kind === 'equip_2' ? (p && (p.chapter >= 2 || p.boss_kills_ch1 > 0)) : true;
    return { name, cost: r.cost, ingredients: r.ingredients, ownedIngredients, missingIngredients, maxCraftable: unlocked ? maxCraftable : 0, unlocked, ...(extra || {}) };
  };
  return {
    gold,
    material: Object.entries(CRAFT_MATERIAL).map(([name, r]) => decorate(name, r, 'material')),
    potion: Object.entries(CRAFT_POTION).map(([name, r]) => decorate(name, r, 'potion')),
    equip_1: Object.entries(CRAFT_EQUIP_1).map(([name, r]) => decorate(name, r, 'equip_1', { quality: 'normal' })),
    equip_2: Object.entries(CRAFT_EQUIP_2).map(([name, r]) => decorate(name, r, 'equip_2', { quality: 'fine' }))
  };
}
function scaleIngredients(ingredients, quantity){
  const outMap = {};
  for(const [mn, qty] of Object.entries(ingredients)) outMap[mn] = qty * quantity;
  return outMap;
}
function consumeMaterials(ownerId, ingredients){
  for(const [mn, qty] of Object.entries(ingredients)){
    let need = qty;
    const rows = all('SELECT * FROM items WHERE owner_id=? AND name=? AND type=? AND location=?', ownerId, mn, 'material', 'backpack');
    let got = 0;
    for(const row of rows) got += row.quantity;
    if(got < need) throw Error('材料不足：缺少 ' + mn + '×' + (need - got));
    for(const row of rows){
      if(need <= 0) break;
      const take = Math.min(need, row.quantity);
      consumeItem(ownerId, row.id, take);
      need -= take;
    }
  }
}
async function handleForgeMaterial(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const recipe = CRAFT_MATERIAL[b.recipe];
  if(!recipe) return out(res, 400, { error: '未知合成配方' });
  const quantity = Math.max(1, Math.min(99, Number(b.quantity) || 1));
  const totalCost = recipe.cost * quantity;
  if(p.gold < totalCost) return out(res, 400, { error: '金币不足' });
  consumeMaterials(u.id, scaleIngredients(recipe.ingredients, quantity));
  p.gold -= totalCost;
  stmt('UPDATE player SET gold=? WHERE user_id=?', p.gold, u.id);
  addItem(u.id, b.recipe, 'material', 'normal', {}, 'backpack', quantity);
  dailyCountInc(u.id, 'forge', '', quantity);
  return out(res, 201, { ok: true, name: b.recipe, type: 'material', quality: 'normal', quantity, cost: totalCost, gold: p.gold });
}
async function handleForgePotion(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const recipe = CRAFT_POTION[b.recipe];
  if(!recipe) return out(res, 400, { error: '未知药水配方' });
  const quantity = Math.max(1, Math.min(99, Number(b.quantity) || 1));
  const totalCost = recipe.cost * quantity;
  if(p.gold < totalCost) return out(res, 400, { error: '金币不足' });
  consumeMaterials(u.id, scaleIngredients(recipe.ingredients, quantity));
  p.gold -= totalCost;
  stmt('UPDATE player SET gold=? WHERE user_id=?', p.gold, u.id);
  addItem(u.id, b.recipe, 'consumable', 'normal', POTION_ITEMS[b.recipe] || {}, 'backpack', quantity);
  dailyCountInc(u.id, 'forge', '', quantity);
  return out(res, 201, { ok: true, name: b.recipe, type: 'consumable', quality: 'normal', quantity, cost: totalCost, gold: p.gold });
}
async function handleForgeEquip(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const r1 = CRAFT_EQUIP_1[b.recipe], r2 = CRAFT_EQUIP_2[b.recipe];
  const recipe = r1 || r2;
  if(!recipe) return out(res, 400, { error: '未知装备配方' });
  const pool = r1 ? CH1_EQUIP : CH2_EQUIP;
  const proto = pool.find(x => x.name === b.recipe);
  if(!proto) return out(res, 400, { error: '未知装备' });
  const quantity = Math.max(1, Math.min(99, Number(b.quantity) || 1));
  const totalCost = recipe.cost * quantity;
  if(p.gold < totalCost) return out(res, 400, { error: '金币不足' });
  consumeMaterials(u.id, scaleIngredients(recipe.ingredients, quantity));
  p.gold -= totalCost;
  stmt('UPDATE player SET gold=? WHERE user_id=?', p.gold, u.id);
  const quality = r1 ? 'normal' : 'fine';
  for(let i = 0; i < quantity; i++) addItem(u.id, proto.name, proto.type, quality, proto.stats, 'backpack', 1);
  return out(res, 201, { ok: true, name: proto.name, type: proto.type, quality, quantity, cost: totalCost, gold: p.gold, stats: proto.stats });
}
const SHOP_CATEGORY_CN = { consumable: '消耗品', material: '材料', equip_box: '装备箱' };
async function handleShopItems(req, res, u){
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  return out(res, 200, {
    gold: p.gold,
    items: Object.entries(SHOP_ITEMS).map(([name, it]) => ({
      name, type: it.type, category: SHOP_CATEGORY_CN[it.type] || '其他',
      price: it.price, stats: it.stats || {},
      maxBuy: it.type === 'equip_box' ? 1 : Math.max(0, Math.floor(p.gold / it.price))
    }))
  });
}
async function handleShopBuy(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const item = SHOP_ITEMS[b.item];
  if(!item) return out(res, 400, { error: '商品不存在' });
  const quantity = Math.max(1, Math.min(99, Number(b.quantity) || 1));
  if(item.type === 'equip_box'){
    if(p.gold < item.price) return out(res, 400, { error: '金币不足' });
    p.gold -= item.price;
    stmt('UPDATE player SET gold=? WHERE user_id=?', p.gold, u.id);
    const proto = CHAPTER_CONFIG[1].equip[randInt(0, CHAPTER_CONFIG[1].equip.length - 1)];
    const q = rollDropQuality('box', 0, 0) || 'normal';
    addItem(u.id, proto.name, proto.type, q, proto.stats, 'backpack', 1);
    dailyCountInc(u.id, 'shop', '', 1);
    return out(res, 201, { ok: true, box: true, name: proto.name, type: proto.type, quality: q, quantity: 1, stats: proto.stats, cost: item.price, gold: p.gold });
  }
  const total = item.price * quantity;
  if(p.gold < total) return out(res, 400, { error: '金币不足' });
  p.gold -= total;
  stmt('UPDATE player SET gold=? WHERE user_id=?', p.gold, u.id);
  if(item.type === 'consumable') addItem(u.id, b.item, 'consumable', 'normal', item.stats || {}, 'backpack', quantity);
  else if(item.type === 'material') addItem(u.id, b.item, 'material', 'normal', {}, 'backpack', quantity);
  else return out(res, 400, { error: '未知商品类型' });
  dailyCountInc(u.id, 'shop', '', quantity);
  return out(res, 201, { ok: true, name: b.item, type: item.type, quantity, cost: total, gold: p.gold });
}
function orderToPayload(row){
  return {
    id: row.id, seller_id: row.seller_id, seller_name: row.seller_name,
    item_id: row.item_id, item_name: row.item_name, item_type: row.item_type,
    item_quality: row.item_quality, item_stats: safeJson(row.item_stats, {}),
    quantity: row.quantity, price: row.price,
    status: row.status, created: row.created, expires_at: row.expires_at
  };
}
/* 交易行（P4）：过期挂单自动下架并归还物品给卖家 */
function expireMarketListings(){
  const expired = all('SELECT * FROM market_listings WHERE status=? AND expires_at<=?', 'active', now());
  if(!expired.length) return 0;
  for(const row of expired){
    addItem(row.seller_id, row.item_name, row.item_type, row.item_quality, safeJson(row.item_stats, {}), 'backpack', row.quantity);
    stmt('UPDATE market_listings SET status=? WHERE id=?', 'expired', row.id);
  }
  return expired.length;
}
async function handleMarketList(req, res, u){
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  expireMarketListings();
  const url = new URL(req.url, 'http://x');
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get('page_size')) || 20));
  const type = url.searchParams.get('type') || '';
  const quality = url.searchParams.get('quality') || '';
  const sort = url.searchParams.get('sort') || 'newest';
  const where = ['status=?'];
  const args = ['active'];
  if(['weapon','armor','accessory','material'].includes(type)){ where.push('item_type=?'); args.push(type); }
  if(['normal','fine','superb','rare','legendary'].includes(quality)){ where.push('item_quality=?'); args.push(quality); }
  const orderBy = sort === 'price_asc' ? 'price ASC, created DESC' : sort === 'price_desc' ? 'price DESC, created DESC' : 'created DESC, id DESC';
  const total = Number(get(`SELECT COUNT(*) AS c FROM market_listings WHERE ${where.join(' AND ')}`, ...args).c) || 0;
  const rows = all(`SELECT * FROM market_listings WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, ...args, pageSize, (page - 1) * pageSize);
  return out(res, 200, {
    fee_rate: MARKET_FEE, duration_hours: 48,
    total, page, page_size: pageSize,
    orders: rows.map(orderToPayload)
  });
}
async function handleMarketCreate(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const item = get('SELECT * FROM items WHERE id=? AND owner_id=?', Number(b.item_id) || 0, u.id);
  if(!item) return out(res, 404, { error: '物品不存在' });
  if(!['weapon','armor','accessory','material'].includes(item.type)) return out(res, 400, { error: '仅装备与材料可挂单交易' });
  if(item.location !== 'backpack') return out(res, 400, { error: '已装备物品不可交易' });
  const price = Number(b.price);
  if(!Number.isFinite(price) || price < 1 || price > 500000) return out(res, 400, { error: '价格须在 1-500000 之间' });
  let quantity = 1;
  if(item.type === 'material') quantity = Math.max(1, Math.min(item.quantity, Number(b.quantity) || 1));
  const expires_at = now() + MARKET_DURATION;
  consumeItem(u.id, item.id, quantity);
  const r = stmt('INSERT INTO market_listings(seller_id,seller_name,item_id,item_name,item_type,item_quality,item_stats,quantity,price,status,created,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    u.id, p.username || '玩家', item.id, item.name, item.type, item.quality, JSON.stringify(safeJson(item.stats, {})), quantity, price, 'active', now(), expires_at);
  return out(res, 201, { ok: true, order_id: Number(r.lastInsertRowid), item_name: item.name, item_type: item.type, item_quality: item.quality, quantity, price, expires_at });
}
async function handleMarketMine(req, res, u){
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  expireMarketListings();
  const rows = all('SELECT * FROM market_listings WHERE seller_id=? ORDER BY created DESC, id DESC', u.id);
  return out(res, 200, {
    fee_rate: MARKET_FEE, duration_hours: 48,
    orders: rows.map(orderToPayload)
  });
}
async function handleMarketBuy(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  expireMarketListings();
  const order = get('SELECT * FROM market_listings WHERE id=?', Number(b.order_id) || 0);
  if(!order || order.status !== 'active') return out(res, 400, { error: '订单不存在或已失效' });
  if(order.expires_at <= now()){
    addItem(order.seller_id, order.item_name, order.item_type, order.item_quality, safeJson(order.item_stats, {}), 'backpack', order.quantity);
    stmt('UPDATE market_listings SET status=? WHERE id=?', 'expired', order.id);
    return out(res, 410, { error: '订单已过期' });
  }
  if(order.seller_id === u.id) return out(res, 400, { error: '不能购买自己的挂单' });
  if(p.gold < order.price) return out(res, 400, { error: '金币不足' });
  const seller = getPlayer(order.seller_id);
  const fee = Math.floor(order.price * MARKET_FEE);
  const sellerGain = order.price - fee;
  stmt('UPDATE player SET gold=? WHERE user_id=?', p.gold - order.price, u.id);
  if(seller) stmt('UPDATE player SET gold=gold+? WHERE user_id=?', sellerGain, seller.user_id);
  addItem(u.id, order.item_name, order.item_type, order.item_quality, safeJson(order.item_stats, {}), 'backpack', order.quantity);
  stmt('UPDATE market_listings SET status=? WHERE id=?', 'sold', order.id);
  stmt('INSERT INTO market_trades(listing_id,seller_id,seller_name,buyer_id,buyer_name,item_name,item_type,item_quality,item_stats,quantity,price,fee,seller_gain,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    order.id, order.seller_id, order.seller_name || '玩家', u.id, p.username || '玩家',
    order.item_name, order.item_type, order.item_quality, order.item_stats, order.quantity, order.price, fee, sellerGain, now());
  return out(res, 201, { ok: true, order_id: order.id, name: order.item_name, quantity: order.quantity, cost: order.price, fee, seller_gain: sellerGain, gold: p.gold - order.price });
}
async function handleMarketCancel(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  expireMarketListings();
  const order = get('SELECT * FROM market_listings WHERE id=?', Number(b.order_id) || 0);
  if(!order || order.status !== 'active') return out(res, 400, { error: '订单不存在或已失效' });
  if(order.seller_id !== u.id) return out(res, 400, { error: '不能下架他人的挂单' });
  if(order.expires_at <= now()){
    addItem(u.id, order.item_name, order.item_type, order.item_quality, safeJson(order.item_stats, {}), 'backpack', order.quantity);
    stmt('UPDATE market_listings SET status=? WHERE id=?', 'expired', order.id);
    return out(res, 410, { error: '订单已过期' });
  }
  addItem(u.id, order.item_name, order.item_type, order.item_quality, safeJson(order.item_stats, {}), 'backpack', order.quantity);
  stmt('UPDATE market_listings SET status=? WHERE id=?', 'cancelled', order.id);
  return out(res, 200, { ok: true, order_id: order.id });
}

/* ========== 体验打磨：背包直接出售给 NPC（第 12 节） ========== */
async function handleSell(req, res, u){
  const b = await body(req);
  const p = getPlayer(u.id);
  if(!p) return out(res, 404, { error: '尚未创建角色' });
  const itemId = Number(b.item_id) || 0;
  const item = get('SELECT * FROM items WHERE id=? AND owner_id=?', itemId, u.id);
  if(!item){
    /* 挂单中的物品已从背包扣减（consumeItem），物品行不存在时检查是否正处于挂单 */
    const listed = get('SELECT id FROM market_listings WHERE item_id=? AND seller_id=? AND status=?', itemId, u.id, 'active');
    if(listed) return out(res, 400, { error: '该物品正在交易行挂单中，请先下架再出售' });
    return out(res, 404, { error: '物品不存在' });
  }
  if(item.location !== 'backpack') return out(res, 400, { error: item.location.startsWith('equipped_') ? '已穿戴物品不可出售，请先卸下' : '该物品不在背包中' });
  let unit = 0;
  if(['weapon','armor','accessory'].includes(item.type)){
    unit = SELL_QUALITY_PRICE[item.quality];
    if(!unit) return out(res, 400, { error: '该装备品质无法估价出售' });
  } else if(item.type === 'material'){
    unit = (SHOP_ITEMS[item.name] || {}).price;
    if(!unit) return out(res, 400, { error: '该材料无法估价出售' });
  } else {
    return out(res, 400, { error: '该物品无法出售' });
  }
  let quantity = 1;
  if(item.type === 'material') quantity = Math.max(1, Math.min(item.quantity, Number(b.quantity) || 1));
  const gain = unit * quantity;
  consumeItem(u.id, item.id, quantity);
  stmt('UPDATE player SET gold=gold+? WHERE user_id=?', gain, u.id);
  return out(res, 200, { ok: true, gold: p.gold + gain, gain, item_name: item.name, item_type: item.type, quantity });
}

    /* ========== 阶段2：副本与战斗接口（第 4 节） ========== */
    if(path === '/api/rpg/dungeon/start' && method === 'POST') return await handleDungeonStart(req, res, u);
    if(path === '/api/rpg/dungeon/event' && method === 'POST') return await handleDungeonEvent(req, res, u);
    if(path === '/api/rpg/dungeon/settle' && method === 'POST') return handleDungeonSettle(req, res, u);
    if(path === '/api/rpg/dungeon/status' && method === 'GET') return handleDungeonStatus(req, res, u);
    if(path === '/api/rpg/dungeon/info' && method === 'GET') return handleDungeonInfo(req, res, u);
    if(path === '/api/rpg/dungeon/settings' && method === 'POST') return await handleDungeonSettings(req, res, u);

    /* ========== 阶段2.5：章节目标接口（第 8 节 P0） ========== */
    if(path === '/api/rpg/goals' && method === 'GET') return await handleChapterGoals(req, res, u);
    if(path === '/api/rpg/goals/claim' && method === 'POST') return await handleGoalClaim(req, res, u);

    /* ========== 阶段2.6：每日任务接口（第 9 节 P1） ========== */
    if(path === '/api/rpg/daily-tasks' && method === 'GET') return await handleDailyTasks(req, res, u);
    if(path === '/api/rpg/daily-tasks/claim' && method === 'POST') return await handleDailyTaskClaim(req, res, u);

    /* ========== 阶段2.7：随机事件接口（第 10 节 P2） ========== */
    if(path === '/api/rpg/events' && method === 'GET') return handleRandomEvents(req, res, u);
    if(path === '/api/rpg/events/choose' && method === 'POST') return await handleRandomEventChoose(req, res, u);

    /* ========== 阶段3：铁匠铺 / 商店 / 交易行接口（第 7 节） ========== */
    if(path === '/api/rpg/forge/catalog' && method === 'GET') return out(res, 200, forgeCatalog(u.id));
    if(path === '/api/rpg/forge/material' && method === 'POST') return await handleForgeMaterial(req, res, u);
    if(path === '/api/rpg/forge/potion' && method === 'POST') return await handleForgePotion(req, res, u);
    if(path === '/api/rpg/forge/equip' && method === 'POST') return await handleForgeEquip(req, res, u);
    if(path === '/api/rpg/shop/items' && method === 'GET') return await handleShopItems(req, res, u);
    if(path === '/api/rpg/shop/buy' && method === 'POST') return await handleShopBuy(req, res, u);
    if(path === '/api/rpg/market/list' && method === 'GET') return await handleMarketList(req, res, u);
    if(path === '/api/rpg/market/listings' && method === 'GET') return await handleMarketList(req, res, u);
    if(path === '/api/rpg/market/mine' && method === 'GET') return await handleMarketMine(req, res, u);
    if(path === '/api/rpg/market/create' && method === 'POST') return await handleMarketCreate(req, res, u);
    if(path === '/api/rpg/market/buy' && method === 'POST') return await handleMarketBuy(req, res, u);
    if(path === '/api/rpg/sell' && method === 'POST') return await handleSell(req, res, u);
    if(path === '/api/rpg/market/cancel' && method === 'POST') return await handleMarketCancel(req, res, u);

    /* ========== 阶段4：长线养成（P5）成就 / 排行榜 / 转生 ========== */
    if(path === '/api/rpg/achievements' && method === 'GET') return handleAchievements(req, res, u);
    if(path === '/api/rpg/achievements/claim' && method === 'POST') return await handleAchievementClaim(req, res, u);
    if(path === '/api/rpg/leaderboard' && method === 'GET') return handleLeaderboard(req, res, u);
    if(path === '/api/rpg/reincarnate' && method === 'POST') return handleReincarnate(req, res, u);

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
    if(path === '/api/admin/users' && method === 'GET') return out(res, 200, all('SELECT id,username,role,disabled,created,display_name,avatar_color,title FROM users ORDER BY id'));
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
      const t = get('SELECT t.*,u.username,u.display_name,u.avatar_color,u.title FROM topics t JOIN users u ON u.id=t.user_id WHERE t.id=?', id);
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
          replies: all('SELECT r.*,u.username,u.display_name,u.avatar_color,u.title FROM replies r JOIN users u ON u.id=r.user_id WHERE topic_id=? ORDER BY r.created LIMIT ? OFFSET ?', id, replyPageSize, (replyPage - 1) * replyPageSize)
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
      const rows = all(`SELECT t.*,u.username,u.display_name,u.avatar_color,u.title,
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
    if(path === '/api/messages' && method === 'GET') return out(res, 200, all('SELECT m.*,u.username,u.display_name,u.avatar_color,u.title FROM messages m JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 100').reverse());
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
    if(path === '/api/my/profile' && method === 'PATCH'){
      const b = await body(req);
      const updates = [], args = [];
      if('display_name' in b){
        const v = String(b.display_name ?? '').trim();
        if(v.length > 24) throw Error('显示名最长 24 个字符');
        updates.push('display_name=?'); args.push(v);
      }
      if('avatar_color' in b){
        const v = String(b.avatar_color ?? '');
        if(v !== '' && !AVATAR_COLORS.includes(v)) throw Error('头像颜色无效');
        updates.push('avatar_color=?'); args.push(v);
      }
      if('title' in b){
        const v = String(b.title ?? '').trim();
        if(v.length > 24) throw Error('称号最长 24 个字符');
        updates.push('title=?'); args.push(v);
      }
      if(updates.length) stmt(`UPDATE users SET ${updates.join(',')} WHERE id=?`, ...args, u.id);
      const updated = get('SELECT id,username,role,display_name,avatar_color,title FROM users WHERE id=?', u.id);
      for(const s of sockets) if(s.user && s.user.id === u.id) s.user = updated;
      presence();
      return out(res, 200, { ok: true, user: updated });
    }
    if(path === '/api/my/password' && method === 'POST'){
      limit(u.id + ':password', 10, 60000);
      const b = await body(req);
      const row = get('SELECT * FROM users WHERE id=?', u.id);
      if(typeof b.old_password !== 'string' || !verify(b.old_password, row.password)) return out(res, 401, { error: '原密码不正确' });
      validCredentials(row.username, b.new_password);
      stmt('UPDATE users SET password=? WHERE id=?', password(b.new_password), u.id);
      return out(res, 200, { ok: true });
    }
    if(path === '/api/my/stats' && method === 'GET'){
      const me = get('SELECT created FROM users WHERE id=?', u.id);
      const topics = get('SELECT COUNT(*) AS c FROM topics WHERE user_id=?', u.id).c;
      const replies = get('SELECT COUNT(*) AS c FROM replies WHERE user_id=?', u.id).c;
      const likes_given = get('SELECT COUNT(*) AS c FROM likes WHERE user_id=?', u.id).c;
      const favorites = get('SELECT COUNT(*) AS c FROM favorites WHERE user_id=?', u.id).c;
      return out(res, 200, { created: me.created, topics, replies, likes_given, favorites });
    }
    if(path === '/api/my/topics' && method === 'GET'){
      const rows = all(`SELECT t.*,u.username,u.display_name,u.avatar_color,u.title,
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
        broadcast('message', { id: Number(r.lastInsertRowid), user_id: u.id, username: u.username, display_name: u.display_name, title: u.title, avatar_color: u.avatar_color, body: bodyText, created: now() });
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
