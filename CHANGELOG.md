---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: b3d9dfb1989d5de331291901cce023f8_ab18b1edc7e911f18569525400638852
    ReservedCode1: q5H+W1yuUIywtYNQTYwzaj4s013IyyH/ZEB1p1JyJIWs3ASJshDilYHs/63Jezn494RfK3MRvSdtE8KIOZkIoRCYa9j+cT1GMYNz+4G6v2ookoxa8UieME+9JbuEozHi2LgLydiNmsUiN/Lu7hbKdPmeiPJjBXxDHb9vzg0WGWFV+kozXMvvmY+QC3E=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: b3d9dfb1989d5de331291901cce023f8_ab18b1edc7e911f18569525400638852
    ReservedCode2: q5H+W1yuUIywtYNQTYwzaj4s013IyyH/ZEB1p1JyJIWs3ASJshDilYHs/63Jezn494RfK3MRvSdtE8KIOZkIoRCYa9j+cT1GMYNz+4G6v2ookoxa8UieME+9JbuEozHi2LgLydiNmsUiN/Lu7hbKdPmeiPJjBXxDHb9vzg0WGWFV+kozXMvvmY+QC3E=
---

# CHANGELOG

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
