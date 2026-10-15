---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: b3d9dfb1989d5de331291901cce023f8_b874bb6cc8b011f18e0e52540064ee0f
    ReservedCode1: GoyiQtSxruh7+9jBO7yxn/LiNm3JC6R23vj9G9dPte1H1MxAvGw8W9aByFUW+3N9fRf6rf/TfTfZ2yfVM4tdTlMn23IEsodTwZ6cmR8km8j3GtwAf91kTIfoKUn78QwDY60YBvyzVAkkBgIOpyCEgbnIc/MGNR6z0uKgUgbUXMWh1R42DtsJOMJq2WY=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: b3d9dfb1989d5de331291901cce023f8_b874bb6cc8b011f18e0e52540064ee0f
    ReservedCode2: GoyiQtSxruh7+9jBO7yxn/LiNm3JC6R23vj9G9dPte1H1MxAvGw8W9aByFUW+3N9fRf6rf/TfTfZ2yfVM4tdTlMn23IEsodTwZ6cmR8km8j3GtwAf91kTIfoKUn78QwDY60YBvyzVAkkBgIOpyCEgbnIc/MGNR6z0uKgUgbUXMWh1R42DtsJOMJq2WY=
---



# CHANGELOG

## Unreleased（未发布）

> 以下改动仅存在于本地工作区，**尚未部署到线上服务器**（线上版本落后于本地）。

### 前端

1. **火焰标记去除**
   - 话题列表回复数旁 🔥 标记移除；分类名 🎈 前缀移除。

2. **个人资料界面重构**
   - 大头像与名称并排对齐（`.profile-head` 改为 `align-items:flex-start`）。
   - 称号由自由输入改为预设池选择佩戴（`AVAILABLE_TITLES` + `.title-picks`）。
   - 头像颜色改为多排纯色块 + 「自动」按钮（`.color-pick.auto`，色块 `border-radius:8px`，移除渐变色盘）。

3. **前端 RPG 阶段4 —— 5 页底部导航与论坛清理**
   - `index.html` 重构：保留登录/注册（邀请码门槛）、个人资料、实时聊天；移除论坛发帖/回复/点赞/收藏/活动/通知/游戏页；`<nav id="bottomNav">` 为空壳，由 `app.js` boot() 注入 5 个 `data-view` 按钮（character/backpack/dungeon/forge/shop）。
   - `app.js` 重构：5 视图 + document 事件委托；登录/注册后调 `/api/me` 取 user；WS 消息按 `{type:'presence'|'message', payload}` 处理、发送用 `ws.send(JSON.stringify({body}))`；副本事件渲染 `choices` 按钮（`data-choice`）并回传选择；底部导航注入与 boot 填充。
   - `style.css` 追加 RPG 样式：角色面板/装备栏、背包四类分页、副本事件/战报、铁匠铺/商店卡片、`.event-choices/.choice` 与底部导航响应式媒体查询。
   - 修正协议偏差：登录取 `/api/me`、WS 用 `ws.send`、奇遇选项渲染、底部导航 JS 注入、boot 填充 bottomNav。
   - 自测：临时实例与干净库实例跑 `phase4_smoke.mjs` 全绿（20/20 通过），覆盖静态资源/认证/角色背包装备/副本全流程/铁匠铺/商店/自动战斗设置/WS 聊天。

### 后端 RPG 阶段1

1. **player / items 表迁移**
   - `player` 表：`user_id` 主键关联 `users`，含 race、level、exp、gold、max_hp、cur_hp、attack、defense、crit_rate、crit_dmg、gold_bonus、daily_count、last_dungeon_date、chapter、boss_kills_ch1/boss_kills_ch2、created。
   - `items` 表：`id` 自增主键、owner_id、name、type（weapon/armor/accessory/consumable/material/quest）、quality（normal/fine/superb/rare）、stats JSON、location（equipped_weapon/equipped_armor/equipped_accessory/backpack）、quantity、created。
   - 启动时 `PRAGMA table_info` 检查缺失列并 `ALTER TABLE ADD COLUMN`，不重建表、不丢数据。

2. **属性计算**
   - `computeStats`：等级基础 + 种族修正 + 装备加成（爆伤加法叠加）。
   - `calcAttackDamage`：普通伤害 `max(1, 攻-防)`，暴击 × 爆伤倍率，多减伤相乘，向下取整最低 1。
   - 种族配置：人族 +10 生命/失败金币损失 5%；精灵 +10% 暴击/装备掉落率 +5 个百分点/防御 -1；矮人 +3 防御/Boss 最终伤害 -10%/暴击 -5%；魔族 +4 攻击/生命低于 30% 攻击 +6/失败金币损失 15%。

3. **新增接口**
   - `POST /api/rpg/character/create`：创建角色（需选择 4 种族之一，重复创建拦截）。
   - `GET /api/rpg/character`：角色面板（含装备概览）。
   - `GET /api/rpg/backpack`：背包（装备/消耗品/材料/任务物品四类，金币独立存储）。
   - `POST /api/rpg/equip`：装备武器/防具/饰品（同部位自动换下）。
   - `POST /api/rpg/unequip`：卸下装备回到背包。

### 后端 RPG 阶段2

1. **战斗引擎与自动战斗**
   - 回合系统 + buff/debuff（腐木妖减伤、盗匪首回合加攻、黑斑巨狼狂暴/破甲、狼王撕裂/流血/狂暴）。
   - 自动战斗流程：玩家攻击 → 怪物攻击 → 判断生命 → 自动药水（默认 <35% 触发、每场最多 1 瓶、不占攻击回合；阈值/次数可配置存 player 表）。

2. **第一章副本（灰烬森林）**
   - 4 事件生成（至少 1 战斗 + 1 非战斗、精英 25%、Boss 35% 固定第 4 格）、5 种怪物、3 种奇遇（含猎人旧地图机制）。
   - 每日 5 次、00:00 刷新不累积、进入即扣次数；失败保留经验/普通材料、金币损失按种族、不掉等级/装备。
   - 掉落概率（普通 16/7/1.8/0.2、精英 30/18/6/1、Boss 30/40/25/5）与升级（经验=等级×100、封顶 6 级）。

3. **新增接口**
   - `POST /api/rpg/dungeon/start`、`/event`、`/settle`、`/status`、`/settings`。

### 后端 RPG 阶段3

1. **marketplace 交易行表迁移**
   - 新增 `marketplace` 表：seller_id/seller_name、item_name/type/quality/stats、quantity、price、status（active/sold/expired/cancelled）、created、expires_at，`(status, expires_at)` 索引；启动时自动把过期挂单置为 expired。

2. **铁匠铺**
   - 材料合成 4 种：精制皮革（粗糙皮革×2）、精炼黑铁（黑铁矿×2）、锐利狼牙（黑狼牙×2）、净化结晶（净化碎片×2）。
   - 药水制作：中型药水（精制皮革×1 + 黑铁矿×1）、大型药水（精炼黑铁×1 + 净化碎片×2）。
   - 装备制作：第一章装备池（猎人短弓/硬皮甲/狼牙项链，normal）+ 第二章装备池（黑铁战斧/矿工重铠/黑铁指环，fine），材料不足/配方未知拦截。

3. **商店**
   - 小型治疗药水（20 金币）、普通装备箱（120 金币，随机一件 1-2 章品质装备）、材料购买（枯木/粗糙皮革/黑铁矿/黑狼牙/净化碎片）。

4. **交易行**
   - 挂单：装备/材料可挂单，价格 1-500000，材料可批量；已装备物品不可交易。
   - 成交：24 小时有效期（MARKET_DURATION），10% 手续费（MARKET_FEE），买卖双方金币即时结算，不能购买自己的挂单，可取消。

5. **第二章副本（沉没矿坑）**
   - 解锁条件：等级 ≥ 3 且 `boss_kills_ch1` ≥ 1，`GET /api/rpg/dungeon/status` 返回 `ch2_unlocked`。
   - 5 种怪物（黑铁守卫/黑雾祭司/毒牙巨蜥/溺亡水鬼/矿坑领主莫拉克 Boss）+ 3 种奇遇（地底商人可选购/黑雾祭坛/被困矿工）+ 第二章装备/材料掉落池。
   - Boss 击杀累计 `boss_kills_ch2`。

### 后端/前端 RPG 阶段5 —— 本地第一版验收（通过）

- 按第一版完成标准跑全链路验收（独立临时 DATA_DIR + 端口 3457 干净实例，`phase5_acceptance.mjs`）：
  - 邀请码门槛注册、4 种族角色创建与种族修正（人族生命/精灵暴击防御/矮人防御减暴击/魔族攻击）、重复建角拦截；
  - 背包四类结构、三栏装备（weapon/armor/accessory）装备/卸下回背包；
  - 副本：每日 5 次（第 6 次被拒）、第一章完整副本（战斗+奇遇+结算、自动战斗回合日志、Boss 击杀计入 `boss_kills_ch1`）、战斗升级、等级封顶 6、中途结算、自动战斗设置保存与回显；
  - 第二章副本：解锁条件校验（level≥3 且 `boss_kills_ch1≥1`，未达标 403 拦截）、完整通关、Boss 击杀计数 `boss_kills_ch2`、地底商人奇遇存在；
  - 铁匠铺：材料合成/药水制作/一章二章装备制作（含 fine 品质）、未知配方与材料不足拦截；
  - 商店：药水/材料/装备箱购买；交易行：挂单/列表/成交（10% 手续费、买卖双方结算）/取消/已装备不可挂单/不能买自己挂单；
  - WS 实时聊天收发与在线广播。
- 验收结果：**68/68 全部通过**。
- 部署状态：项目内**无部署脚本、服务器地址、SSH 凭据、README 部署说明**，线上部署未执行，缺少部署信息详见 `TODO.md`。

### 备注

- 阶段2、阶段3、阶段4、阶段5（本地验收）均已本地实现并通过 E2E 自测（阶段3 自测 27/27、阶段4 自测 20/20、阶段5 本地验收 68/68），尚未部署到线上服务器；阶段5 剩余「上传服务器并重启线上服务」待部署信息补齐后执行，详见 `TODO.md`。

## v1.1.0 - 2026-10-14

> 本项目为 Node.js 零框架全栈私人贴吧（Campfire Arcade · 篝火社区）。
> 本次更新涵盖功能新增、管理员能力补齐、UI 布局重构与若干 Bug 修复。

### 功能新增

1. **图片上传**
   - 后端新增 `POST /api/upload`：接收完整 data URL，正则校验图片类型，单张上限 5MB，返回 `{ url }`。
   - `GET /uploads/` 静态服务增加文件名白名单校验。
   - 前端 `uploadImage()` 使用 canvas 缩放（最长边 1600px）并转 JPEG 0.85 压缩，降低上传体积。
   - 支持富文本按钮上传与图片拖拽上传两种入口，上传后插入光标处。

2. **Markdown 渲染**
   - 新增前端轻量 `renderMarkdown()` 解析器：支持标题、粗体/斜体、有序/无序列表、引用、代码块、图片（白名单过滤）。
   - 先 HTML 转义再套用语法，防止 XSS 注入；话题正文与回复均渲染为 `.markdown-body`。

3. **分页能力**
   - `GET /api/topics` 支持 `page` / `pageSize` 参数，默认每页 20 条、上限 50。
   - `GET /api/topics/:id` 回复分页移除原先 500 条硬上限，同样支持 `page` / `pageSize`。
   - 前端话题列表与回复列表增加分页页码条。

### 管理员入口补齐

- 后端已具备 DELETE / PATCH 话题接口，本次补齐前端管理入口：
  - 话题卡片与管理员详情页渲染「置顶 / 关闭 / 删除」按钮（`data-action`，不冒泡触发 `open-topic`）。
  - 新增 `doAdminPin()` / `doAdminClose()` / `doAdminDelete()`，PATCH 请求同传 `pinned` + `closed` 布尔值，删除操作带 `confirm` 确认。
  - 通过 document 事件委托统一挂载 `admin-pin / admin-close / admin-delete` 分支，操作完成后刷新当前视图。

### UI / 布局改动（响应式自适应重构）

- 主界面三列 grid 重构：`.shell` 拓宽至 `max-width:1920px`，中间列 `minmax(0,1fr)` 消除留白过大与内容过窄问题。
- 断点规划：
  - `≤1280px`：三列收窄过渡；
  - `≤1024px`：聊天室由侧列转为右下角浮动层，默认收起（仅显示 💬 入口），由用户主动展开，避免遮挡内容；
  - `≤860px`：侧边栏转为抽屉 + 遮罩（`.side-mask`）；
  - `≤600px`：单列布局。
- `index.html` 新增 `menuBtn / chatToggleBtn / chatCloseBtn / sideMask` 控件。
- `bindResponsiveUI()` 统一绑定菜单开合、聊天室折叠与遮罩行为；`syncChatFab()` 初始化浮动按钮状态。
- 卡片对齐与间距统一：缩略图 `line-height:1`、标题 flex 居中、stat/poster/stats 间距统一，整体收紧 padding/margin。
- `body` 增加 `overflow-x:hidden` 防止横向溢出。

### Bug 修复

1. **聊天室连接未调用**：`connectChat()` 未在启动流程中被调用导致聊天室恒为 0 人在线；已在 `enterShell()` 中 `bindChat()` 之后追加 `connectChat()`，覆盖登录后与刷新已登录两种场景。
2. **图片上传 data 前缀丢失**：`uploadImage()` 原先取 `split(',')[1]` 导致后端正则校验失败；改为发送完整 data URL。
3. **话题列表接口双重包装**：`server.mjs` 原先 `out(res, 200, {topics: topicList(...)})` 造成前端 `map is not a function`；改为直接 `out(topicList(u, qs))`。
4. **响应式默认态被媒体查询覆盖**：`.menu-btn` / `.chat-close` / `.chat-fab` 的默认 `display:none` 原写在 `@media` 之后，窄屏按钮不可见；已移至所有媒体查询之前，并避免用 `.hidden` 强压媒体查询显示。
5. **聊天室浮动断点过早遮挡**：浮动断点由 1200px 下调至 1024px，中屏保持 grid 第三列，避免聊天室浮层覆盖内容区。

### 校验说明

- `server.mjs` 与 `public/app.js` 均通过 `node --check` 语法校验；CSS 括号平衡检查通过。
- `uploads/` 目录由服务启动时自动创建。
*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
