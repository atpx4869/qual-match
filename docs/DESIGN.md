# qual-match 设计文档

> 资质匹配核查工具 —— 导入标准清单，比对省级 CMA / CNAS / 国家 CMA / 一单一库四类资质，
> 支持资质本地保存、综合查询、结果导出。
>
> 本程序是 `bzxz`（标书系统）资质模块的独立缩小版。后续会成为独立仓库。**仅 Web，无桌面客户端。**
>
> **设计文档 6 节已全部完成**。实施进度（按 §6.1）：✅ 阶段 0 脚手架 + ✅ 阶段 1 主链路 +
> ✅ 阶段 2 综合查询 + ✅ 阶段 3 一单一库自动同步（MVP 闭环）+ ✅ 阶段 4 省级 CMA/CNAS 抓取
> （省级 CMA 联网验证 28110 条、CNAS 联网验证 7451 条，均匹配命中，2026-06-05），
> ✅ 阶段 6 打磨（设置页 / 部署说明 / 全库备份，2026-06-07）。
> ✅ 阶段 5 国家 CMA 在线抓取已打通（2026-06-08，滑块缺口直检 + 三层下钻，原止损翻案；前后端已接入，Excel 导入降级仍保留）。

---

## 第 1 节 · 项目概述与整体架构

### 1.1 项目定位

`qual-match` 解决一个具体场景：**某检测机构手上有一份标准清单（Excel），想知道这些标准
里自己机构能做哪些、不能做哪些 —— 即每个标准是否被本机构的资质（省级 CMA / CNAS /
国家 CMA / 一单一库）覆盖。**

> **单一机构定位（2026-06-02 澄清）**：本工具服务于「本机构自查」，不做跨机构对比。
> 导入的资质明细全部视作「本机构持有」，无需机构列。匹配结果回答的是「本机构在某类资质下
> 有没有这个标准的能力」（✓有 / —无），而非「哪些机构能做」。这简化了数据模型的使用：
> 明细表的 `cert_number`/`lab_no` 用固定占位标识承载本机构，结构不变（仍带三层归一列）。
> 一单一库是政策范围（不分机构），语义不受此影响。

与主项目 `bzxz` 的关系：

| 维度 | bzxz（主项目） | qual-match（本项目） |
|------|---------------|---------------------|
| 核心场景 | 标准检索 + 下载 + 资质徽章（资质是辅助信息） | **资质匹配核查是主线** |
| 资质数据源 | 省级 CMA、CNAS、一单一库 | 省级 CMA、CNAS、一单一库 **+ 国家 CMA（新增）** |
| 用户模型 | 多用户 + tab 权限 + 登录 | **单用户 / 无登录** |
| 客户端 | Web + Electron 桌面端 | **仅 Web** |
| 前端 | 原生 JS 多文件全局拼装 | **Vue 3 + Vite + Element Plus** |
| 后端 | Express 5 + TS + better-sqlite3 | **延续：Express 5 + TS + better-sqlite3** |
| 下载/预览 PDF | 有（核心功能） | **无**（不涉及标准原文下载） |

一句话：**砍掉 bzxz 的标准检索/下载/预览/多用户，保留并强化资质匹配，新增国家 CMA 源。**

### 1.2 核心数据流

```
┌─────────────┐   导入          ┌──────────────┐   交叉匹配    ┌──────────────┐
│ Excel 标准   │ ────────────▶ │  标准清单     │ ───────────▶ │  匹配结果     │
│ 清单         │               │ (watchlist)  │              │ (按标准号聚合) │
└─────────────┘               └──────────────┘              └──────┬───────┘
                                      │                              │
                                      │ 比对                         │ 导出
                                      ▼                              ▼
                          ┌────────────────────────┐         ┌──────────┐
                          │   4 类资质本地库         │         │  Excel   │
                          │ ┌────────┬───────────┐  │         └──────────┘
                          │ │省级CMA  │  CNAS     │  │
                          │ ├────────┼───────────┤  │  ◀── 在线抓取 / Excel 导入写入
                          │ │国家CMA  │ 一单一库   │  │
                          │ └────────┴───────────┘  │
                          └────────────────────────┘
                                      ▲
                                      │ 综合查询（独立于清单的关键词查询）
                                      └──────────────────────────────
```

**两条独立的查询路径**（都建立在「4 类资质本地库」之上）：

1. **清单驱动匹配（主线）**：导入清单 → 每个标准号去 4 类资质库交叉查 → 按标准号聚合
   出「这个标准被谁、被哪类资质覆盖」→ 导出。
2. **综合查询（辅助）**：不依赖清单，直接对本地资质库做关键词/标准号查询，
   类似 bzxz 的「资质查询」页。

### 1.3 资质本地保存机制

四类资质**统一采用「订阅机构 → 抓取/导入明细 → 落本地 SQLite」**的模式（沿用 bzxz）：

- **省级 CMA / CNAS / 国家 CMA**：以「机构」为订阅单位。用户添加一个机构（证书编号 /
  实验室编号），程序抓取该机构的全部资质能力明细存本地；支持手动同步更新。
- **一单一库**：以「领域」为订阅单位（市场监管总局能力项目库，是「政策范围内合法标准号
  清单」，非机构持有资质）。

首版策略（按你的决策）：**抓取后置**。先支持从 Excel 导入 / 手工录入资质明细到本地库，
抓取器作为增强逐源接入，降低首版风险。详见第 3 节。

### 1.4 技术栈

| 层 | 选型 | 复用来源 |
|----|------|---------|
| 后端运行时 | Node.js + TypeScript | bzxz |
| Web 框架 | Express 5 | bzxz |
| 数据库 | better-sqlite3（单文件 SQLite） | bzxz |
| HTML 抓取 | cheerio | bzxz cma/cnas scraper |
| 动态渲染抓取 | playwright（CNAS；国家 CMA 在线抓取） | bzxz cnas-scraper + 国家 CMA PoC |
| Excel 读写 | xlsx（SheetJS） | bzxz check/cap-lib 导出 |
| 请求校验 | zod | bzxz |
| 标准号归一化 | 三层 std-code（cleanStdCode / extractFullCode / extractBaseCode） | bzxz src/shared/std-code.ts **直接移植** |
| 前端框架 | Vue 3 + Vite + TypeScript | 新写 |
| UI 组件库 | Element Plus | 新写 |
| 前端表格/导出 | Element Plus Table + xlsx（前端导出兜底） | 新写 |

### 1.5 整体分层架构

```
┌───────────────────────────────────────────────────────────┐
│                  前端 (web/, Vue 3 + Vite)                  │
│  页面：清单匹配 / 综合查询 / 资质管理 / 设置                  │
│  通过 REST API + Result 壳与后端通信                         │
└────────────────────────┬──────────────────────────────────┘
                         │ HTTP (JSON, /api/*)
┌────────────────────────▼──────────────────────────────────┐
│                   后端 (src/, Express 5)                    │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ api/        路由层：解包 zod、Result 壳、camel/snake  │  │
│  ├─────────────────────────────────────────────────────┤  │
│  │ services/   业务层：匹配引擎、资质管理、同步编排、导出 │  │
│  ├─────────────────────────────────────────────────────┤  │
│  │ sources/    在线抓取器：省级 CMA / CNAS               │  │
│  ├─────────────────────────────────────────────────────┤  │
│  │ shared/     std-code 归一化、http 池、错误、响应壳     │  │
│  └─────────────────────────────────────────────────────┘  │
│                         │                                   │
│                  better-sqlite3                             │
│                  data/qual-match.db                         │
└───────────────────────────────────────────────────────────┘
```

**沿用 bzxz 的关键工程约定**（详见各节展开）：

- **Result 响应壳** `{ data, error }`，统一 `respond()` / `respondError()`。
- **命名边界**：DB snake_case ↔ API camelCase，路由层转换。
- **std_code 三层归一化契约**：任何资质 INSERT 都要 `cleanStdCode → std_code_norm
  (extractFullCode) → std_code_base (extractBaseCode)`，否则匹配会漏命中。这是 bzxz
  踩过最多坑的地方，直接移植其单一真相源 `shared/std-code.ts` + 单测。
- **同步串行化 + 分块事务**：better-sqlite3 事务同步阻塞主线程，大批量入库按 ~2000 行
  分块、批次间 `setImmediate` 让出事件循环，避免页面假死。

### 1.6 目录结构总览

```
qual-match/
├── src/                          后端
│   ├── api/                      路由层
│   │   ├── app.ts                Express app 装配
│   │   ├── watchlist-routes.ts   清单导入/匹配/导出
│   │   ├── qualification-routes.ts 综合查询
│   │   ├── source-routes.ts      省级 CMA / CNAS 同步与订阅
│   │   ├── cap-lib-routes.ts     一单一库领域订阅/同步
│   │   ├── import-routes.ts      资质明细导入
│   │   ├── system-routes.ts      设置页：总览/配置/备份
│   │   └── health-routes.ts
│   ├── services/
│   │   ├── match-service.ts      ★ 清单 × 4 资质交叉匹配引擎
│   │   ├── qualification-service.ts 机构型资质本地库综合查询
│   │   ├── sync-progress.ts      公共进度 store + 全局串行队列
│   │   ├── scrape-service.ts     省级 CMA / CNAS 抓取入库编排
│   │   ├── cap-lib-service.ts    一单一库分页同步 + 5 档比对
│   │   ├── system-service.ts     设置页总览 + CNAS 设置 + 全库备份
│   │   ├── import-service.ts     Excel 导入（清单 + 资质明细）
│   │   ├── export-service.ts     匹配结果 / 查询结果导出 Excel
│   │   └── db.ts                 schema + 迁移 + 归一化回填
│   ├── sources/                  在线抓取器
│   │   ├── prov-cma/             省级 CMA（移植 bzxz cma-scraper）
│   │   ├── cnas/                 CNAS（移植 bzxz cnas-scraper）
│   │   └── cnas/preset-cnas-labs.ts
│   ├── shared/
│   │   ├── std-code.ts           ★ 三层归一化（移植 bzxz）
│   │   ├── response.ts           Result 壳
│   │   ├── errors.ts             AppError 体系
│   │   ├── case.ts               camel/snake 转换
│   │   └── http.ts               undici 连接池
│   └── index.ts                  启动入口
├── web/                          前端（Vue 3 + Vite）
│   ├── src/
│   │   ├── pages/                清单匹配 / 综合查询 / 资质管理 / 设置
│   │   ├── components/           覆盖徽章、状态标签、同步进度、资质导入弹窗
│   │   ├── api/                  fetch 封装（解 Result 壳）
│   │   └── main.ts
│   ├── index.html
│   └── vite.config.ts
├── data/                         运行时数据（gitignored）
│   └── qual-match.db
├── docs/
│   └── DESIGN.md                 本文档
├── package.json
├── tsconfig.json
└── README.md
```

---

---

## 第 2 节 · 数据模型设计

> 单文件 SQLite（`data/qual-match.db`），better-sqlite3。所有列 `snake_case`。
> 表分四组：**资质源数据**（4 类）、**标准清单**、**匹配结果缓存**、**配置/日志**。

### 2.0 设计总原则

1. **std_code 三层列是地基**。每张含标准号的表都带三列：
   - `std_code`      —— 清洗后的原始号（`cleanStdCode`，折叠脏空格，保留写法）
   - `std_code_norm` —— 保年归一化（`extractFullCode`，**精确同号同年匹配走这列**，建索引）
   - `std_code_base` —— 剥年归一化（`extractBaseCode`，跨年兜底，建索引）

   bzxz 的教训：这两个归一列在老版本里是后置迁移加的，踩过「诊断能拉到、搜索匹不上」
   的坑。**新项目一开始就把三列写进 CREATE TABLE**，并保留 bzxz 的 `STD_CODE_ALGO_VERSION`
   回填机制（算法升级时全量重算）。

2. **机构资质（持有）与能力库（政策范围）正交**。省级 CMA / CNAS / 国家 CMA 是「某机构
   持有哪些标准的资质」；一单一库是「哪些标准在能力项目库内」。两类语义不可混表。

3. **资质明细统一形态**。三个「机构型」源（省级 CMA / CNAS / 国家 CMA）的明细表结构高度
   一致，便于匹配引擎用统一 SQL 查。差异字段用各源专属列承载，不强行抹平。

### 2.1 资质源数据表（机构型，3 张机构表 + 3 张明细表）

机构表结构统一（以 CNAS 为例，CMA/国家CMA 同构，主键标识不同）：

```sql
-- 机构订阅表（CNAS：以 lab_no 标识；省级CMA/国家CMA：以 cert_number 标识）
CREATE TABLE cnas_labs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_no         TEXT NOT NULL UNIQUE,       -- 机构唯一标识
  lab_name       TEXT DEFAULT '',
  -- 抓取定位用的源专属字段（CNAS: base_info_id；CMA: public_detail_id）
  source_ref     TEXT DEFAULT '',
  region         TEXT DEFAULT '',            -- 省份/地区（省级CMA有用）
  -- 同步状态机（统一）
  last_sync_at   TEXT,
  sync_status    TEXT DEFAULT 'pending',     -- pending/syncing/success/error
  sync_error     TEXT,
  record_count   INTEGER DEFAULT 0,
  data_origin    TEXT DEFAULT 'manual',      -- manual(Excel导入) / scraped(抓取)
  subscribed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

资质明细表统一结构（三源各一张，列对齐）：

```sql
CREATE TABLE cnas_qualifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_no          TEXT NOT NULL,             -- 机构外键（CMA系为 cert_number）
  std_code        TEXT NOT NULL,             -- ① 清洗后原始号
  std_code_norm   TEXT NOT NULL DEFAULT '',  -- ② 保年归一（索引）
  std_code_base   TEXT NOT NULL DEFAULT '',  -- ③ 剥年归一（索引）
  std_name        TEXT DEFAULT '',           -- 标准名称
  effective_date  TEXT DEFAULT '',
  expiry_date     TEXT DEFAULT '',
  category        TEXT DEFAULT '',           -- 大类
  sub_category    TEXT DEFAULT '',
  test_object     TEXT DEFAULT '',           -- 检测对象（CNAS）
  test_param      TEXT DEFAULT '',           -- 检测参数/项目
  test_standard   TEXT DEFAULT '',           -- 依据标准全称
  limit_desc      TEXT DEFAULT '',           -- 限制范围/说明
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cnas_qual_norm ON cnas_qualifications(std_code_norm);
CREATE INDEX idx_cnas_qual_base ON cnas_qualifications(std_code_base);
CREATE INDEX idx_cnas_qual_lab  ON cnas_qualifications(lab_no);
```

**省级 CMA（`prov_cma_labs` / `prov_cma_qualifications`）**：机构主键 `cert_number`，
明细字段对齐上表，`test_param` 承载 CMA 的检测项目（`test_item`），保留 `place_name`
（场所名）专属列。

**国家 CMA（`nat_cma_labs` / `nat_cma_qualifications`）**：同省级 CMA 结构。机构主键
`cert_number`（如示例 `230020349767`）。源专属字段 `apply_id` / `place_id`
（cma.cnca.cn 列表接口参数，实施时按逆向结果定）。

> 为什么不合并成一张大表加 `source` 列？bzxz 的实践是分表——各源同步/删除独立事务、
> 抓取字段差异大、索引互不干扰。匹配引擎用 `UNION ALL` 跨表查即可（第 4 节）。

### 2.2 一单一库表（能力库型，移植 bzxz）

直接沿用 bzxz 的 `cma_capability_lib` + `cma_capability_lib_meta`，命名改为
`cap_lib` / `cap_lib_meta`，语义与 schema 不变：

```sql
CREATE TABLE cap_lib (
  source_id       INTEGER PRIMARY KEY,        -- 远端 id（连续），upsert 用
  domain          TEXT NOT NULL DEFAULT '',   -- 11 个顶层领域之一
  standard_method TEXT NOT NULL DEFAULT '',
  std_code        TEXT NOT NULL,
  std_code_norm   TEXT NOT NULL DEFAULT '',
  std_code_base   TEXT NOT NULL DEFAULT '',
  remark          TEXT DEFAULT '',
  lib_status      TEXT NOT NULL DEFAULT 'active', -- active/cite_only/abolished
  raw_status      TEXT DEFAULT '',
  row_hash        TEXT NOT NULL DEFAULT '',   -- sha1 diff，避免无变更重写
  last_seen_at    TEXT NOT NULL DEFAULT '',   -- soft delete 依据
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cap_lib_norm ON cap_lib(std_code_norm);
CREATE INDEX idx_cap_lib_base ON cap_lib(std_code_base);

CREATE TABLE cap_lib_meta (
  domain         TEXT PRIMARY KEY,
  subscribed     INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT DEFAULT '',
  remote_total   INTEGER DEFAULT 0,
  local_total    INTEGER DEFAULT 0,
  last_sync_stats TEXT DEFAULT ''
);
```

一单一库的「5 档比对状态」逻辑（`parseLibStatus` / `active / cite_only / abolished /
series_only / not_in_lib`）整套移植（`shared/cap-lib-status.ts`）。

### 2.3 标准清单表

```sql
-- 一份导入的标准清单
CREATE TABLE watchlists (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  matched_at      TEXT,                       -- 上次执行匹配的时间
  item_count      INTEGER NOT NULL DEFAULT 0
);

-- 清单内的标准号
CREATE TABLE watchlist_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id  INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  std_code      TEXT NOT NULL,                -- 清洗后原始号
  std_code_norm TEXT NOT NULL DEFAULT '',     -- 保年归一（匹配键）
  std_code_base TEXT NOT NULL DEFAULT '',     -- 剥年归一（跨年兜底）
  std_name      TEXT DEFAULT '',              -- 导入时若 Excel 带名称则存
  seq           INTEGER NOT NULL DEFAULT 0    -- 清单内行序，导出保持原顺序
);
CREATE INDEX idx_wl_items_wl   ON watchlist_items(watchlist_id);
CREATE INDEX idx_wl_items_norm ON watchlist_items(std_code_norm);
```

**与 bzxz `check_*` 的区别**：bzxz 的清单是「查新」用（跟踪标准状态变化、存基线快照）；
本项目清单是「资质匹配」用，**不存基线、不查新**，结构大幅简化。清单项只需标准号 + 归一列。

### 2.4 匹配结果：缓存表 vs 实时计算

两种方案：

| 方案 | 做法 | 取舍 |
|------|------|------|
| **实时计算（首版采用）** | 每次打开清单/导出时，用 `std_code_norm IN (...)` 一次性批量查 4 类资质库现算 | 数据永远最新（资质库更新后立即反映）；清单规模有限（≤几百标准），批量 IN 查询 O(log N) 足够快；无缓存一致性问题 |
| 缓存表 | 匹配结果落 `match_results` 表 | 仅当清单极大或匹配逻辑很重时才需要；增加「资质库更新后缓存失效」的复杂度 |

**首版选实时计算**——匹配引擎是纯查询，参照 bzxz `queryByStdCodes` 的批量 IN 实现
（单次 SQL 查全部命中），无需落缓存表。若后续清单规模暴涨再引入缓存。

### 2.5 配置与日志表

```sql
-- 全局配置（键值对，无多用户所以无 user 维度）
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- 同步日志（4 类源共用，source 区分）
CREATE TABLE sync_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL,              -- prov_cma/cnas/nat_cma/cap_lib
  target          TEXT NOT NULL,              -- 机构标识 或 领域名
  action          TEXT NOT NULL,              -- import/scrape/sync
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  status          TEXT DEFAULT 'success',
  records_fetched INTEGER DEFAULT 0,
  error_message   TEXT
);
```

`settings` 存什么：std-code 算法版本、CNAS 浏览器路径、CNAS 抓取节流等运行参数。无 localStorage
之外的 UI 偏好仍走前端 localStorage（沿用 bzxz 三层配置约定的简化版：DB settings + 前端
localStorage，无 Electron 层）。

### 2.6 表关系总览

```
watchlists 1──n watchlist_items
                     │ std_code_norm（匹配键，实时 IN 查询）
                     ▼
   ┌─────────────────┼─────────────────┬──────────────┐
   ▼                 ▼                 ▼              ▼
cnas_qual      prov_cma_qual      nat_cma_qual      cap_lib
   │ lab_no        │ cert_number     │ cert_number   (无机构，能力库)
   ▼               ▼                 ▼
cnas_labs      prov_cma_labs     nat_cma_labs

sync_logs ── 记录 4 类源的 import/scrape/sync 动作
settings  ── 全局配置
```

---

## 第 3 节 · 抓取 / 数据源层

> 4 类资质源的数据获取。核心策略（按决策）：**抓取后置** —— 首版先支持 Excel 导入 / 手工
> 录入资质明细到本地库，抓取器作为增强逐源接入。这样首版不被任一源的反爬/验证码卡死。

### 3.1 当前数据源编排

实际落地时没有强抽 `QualSourceAdapter` 基类，而是按源保留抓取器差异，由 service 层统一收口：

- `scrape-service.ts`：编排省级 CMA / CNAS 抓取、三层归一化、replace 入库和 labs 占位行维护。
- `cap-lib-service.ts`：一单一库领域分页同步、hash diff、soft delete、5 档比对。
- `sync-progress.ts`：公共 job 进度 store + 全局串行队列，cap-lib 与 scrape 共用。
- `import-service.ts`：清单 Excel / 粘贴导入，以及三类机构型资质 Excel 导入。

这个结构更贴合各源差异：省级 CMA 是 HTTP+HTML，CNAS 是 playwright+JSL 反爬，一单一库是 RuoYi JSON
分页接口，国家 CMA 是 playwright + 滑块缺口直检 + 三层下钻抓取。

### 3.2 入库统一归一化（强制契约）

**任何源的明细入库前，必须过三层归一化**（移植 bzxz 单一真相源 `shared/std-code.ts`）：

```ts
const stdCode = cleanStdCode(raw.stdCode);          // ① 清洗脏空格
if (!stdCode) continue;                              // 空号跳过
const norm = extractFullCode(stdCode);               // ② 保年归一
const base = extractBaseCode(stdCode);               // ③ 剥年归一
insert.run(target, stdCode, norm, base, /* ...其余字段 */);
```

入库走**分块事务**（每 ~200 行一个事务，批次间 `setImmediate` 让出事件循环），
避免 better-sqlite3 同步事务阻塞主线程导致页面假死（bzxz 踩过的坑）。

### 3.3 省级 CMA（移植 bzxz `cma-scraper.ts`）

- **来源**：bzxz 现有省级 CMA 抓取（HTTP + cheerio 解析 HTML 列表/详情页）。
- **移植内容**：`searchLabsByName`（按机构名搜候选）、`getDetail`（取证书号/有效期等）、
  `scrapeFull`（抓全部能力明细）。
- **改造**：去掉 bzxz 的「更新检测 checkForUpdate」；抓取结果在 `scrape-service.ts` 中映射并入库。
- **机构标识**：`cert_number`；抓取定位字段 `public_detail_id`。

### 3.4 CNAS（移植 bzxz `cnas-scraper.ts`）

- **来源**：bzxz 现有 CNAS 抓取，基于 **playwright**（CNAS 站点需浏览器渲染）。
- **关键复用**：`CnasScraper` 的**页面池**（共享 browser + 每任务独立 context/page +
  信号量 `maxConcurrent=3`）。直接移植，单用户场景下并发压力更小。
- **机构标识**：`lab_no`；抓取定位字段 `base_info_id` + `url_params`。
- **playwright 依赖**：新项目 package.json 需带 playwright；首次运行需
  `npx playwright install chromium`。README 写明。

### 3.5 国家 CMA（`cma.cnca.cn`）

国家 CMA 在线抓取已打通并接入生产代码。2026-06-08 复盘结论：原“滑块命中率不稳”判断来自模板匹配偏移，
稳定方案是对背景图缺口行做垂直 Sobel，直接检测缺口左缘作为 `moveX`。入口语义也已确认：
`list` 按机构名返回候选机构与 `placeId/applyId`，再按场所下钻到 `formAbility` 分页抓能力明细。

当前策略：

- 后端实现 `src/sources/nat-cma/nat-cma-scraper.ts`，service/routes 接入 `/api/sources/nat_cma/search|subscribe|sync`。
- 前端 `SourcesPage` 已接入国家 CMA tab，支持搜索、订阅、同步和进度轮询。
- 设置页提供 `nat_cma_scrape_enabled` 开关、国家 CMA 浏览器路径和节流设置；默认关闭，用户确认后启用。
- Excel 导入降级仍保留，导入明细与在线抓取一样参与主匹配、综合查询和导出。

**机构标识**：`cert_number`。单机构定位下，导入明细仍写入 `SELF_ORG_ID='_self'`。

### 3.6 一单一库（移植 bzxz `cap-lib-service.ts`）

- **来源**：`https://cma.caqit.org.cn/cma-admin/system/standardData/list`，无鉴权。
- **整套移植**：11 个顶层领域常量、分页拉取（`pageSize=2000` 逐页）、同步串行化
  （`syncChain` 并发 1）、hash diff + soft delete、5 档比对状态解析。
- **领域常量**：`shared/cap-lib-domains.ts` 与 db schema 的领域初始化数组手动保持一致。
- 这是四源里最成熟、风险最低的，几乎零改动移植。

### 3.7 同步编排（sync-progress + service 编排）

实际实现拆成两层：

- `sync-progress.ts`：内存进度 store、`makeJobId`、全局串行 `enqueueSync`。
- `cap-lib-service.ts`：一单一库按领域分页拉取、hash diff upsert、soft delete。
- `scrape-service.ts`：省级 CMA / CNAS 抓取、映射、三层归一化、分块替换入库。

**串行化原则**（移植 bzxz）：所有大同步任务共用模块级串行队列，避免多个 better-sqlite3 大事务
连环锁死事件循环。单用户场景并发本就低，串行更安全。

### 3.8 Excel 导入（主路径 + 国家 CMA 降级）

抓取后置，所以资质数据始终保留**导入**路径：

- **Excel 导入资质明细**：用户准备一份含「标准号 / 标准名 / 检测项目 / 机构 / 有效期」等
  列的 Excel，`import-service` 用 xlsx 解析 → 三层归一化 → 入对应源的明细表。
  导入时指定 source；单机构定位下机构列统一写 `SELF_ORG_ID`。
- **标准清单导入**：Excel 上传或粘贴标准号，入 `watchlists` / `watchlist_items`。
- 导入的机构占位行 `data_origin='manual'`，与抓取行（`scraped`）区分，便于设置页展示来源。

> 导入与抓取产出同一张明细表、同样过三层归一化，所以匹配引擎对「导入的」和「抓来的」
> 资质一视同仁。

---

## 第 4 节 · 匹配引擎与 API

### 4.1 匹配引擎（match-service）—— 核心

输入：一份清单的标准号集合。输出：每个标准号在 4 类资质中的覆盖情况。

**算法（参照 bzxz `queryByStdCodes` 的批量 IN 查询）：**

```
1. 取清单全部 std_code_norm（保年归一）+ std_code_base（剥年归一），去重。
2. 一次性批量查机构型资质库 + 一单一库：
   - CNAS:     SELECT ... WHERE std_code_norm IN (:norms)
   - 省级CMA:  SELECT ... WHERE std_code_norm IN (:norms)
   - 国家CMA:  SELECT ... WHERE std_code_norm IN (:norms)
   - 一单一库: 走 5 档比对（std_code_norm 等值 + std_code_base 兜底）
3. 把命中行按「输入标准号」归集，每个标准号产出一个 MatchResult。
```

**保年优先、剥年兜底**（沿用 bzxz 语义铁律）：

- **主匹配走 `std_code_norm`（保年）**：`GB/T 3325-2024` 只匹库里 2024 版的资质，
  不会因库里有 2013 版而误命中。同号不同年是不同资质。
- **剥年 `std_code_base` 仅作「跨年提示」**：当保年没命中、但剥年命中其他年版时，
  给出「该标准系列有 XXXX 年版资质」的提示（不等于覆盖）。

**单条匹配结果结构：**

```ts
interface MatchResult {
  stdCode: string;            // 清单原始号
  stdName: string;
  controlledNo: string;
  hasText: string;
  department: string;
  // 3 类机构型资质覆盖状态
  provCma: SourceCoverage;
  cnas:    SourceCoverage;
  natCma:  SourceCoverage;
  capLib:  CapLibStatus;      // 一单一库 5 档状态（in_lib/cite_only/abolished/series_only/not_in_lib）
  // 汇总
  coveredBy: ('prov_cma'|'cnas'|'nat_cma')[];  // 被哪几类机构型资质覆盖
  matched: boolean;           // 是否至少被一类机构型资质覆盖；cap_lib 不计入
}
interface SourceCoverage {
  covered: boolean;           // 保年命中才算覆盖
  testParams: string[];       // 命中行检测项目去重聚合
  seriesHint: boolean;        // 保年未命中、剥年命中其他年版
  seriesCodes: string[];      // 其他年版标准号
}
```

**性能**：清单匹配走分块 `IN` 查询与服务端分页/筛选/排序，适配数百到数千条清单的日常使用。

### 4.2 综合查询（qualification-service）

独立于清单的关键词/标准号查询，参照 bzxz `searchQualifications` + `searchByStandard`：

- **行级搜索**：关键词命中标准号 / 标准名 / 检测项目，跨 3 个机构型源查询，分页返回。
- **按标准号聚合**：同一标准号下的全部资质行聚合成一组（产品标准可展开看完整覆盖）。
- **带年/不带年分流**（移植 bzxz）：用户输入带 4 位年份 → 严格保年；不带年 → 保年+剥年双路径。
- **源过滤**：可只查某一类机构型资质（省级CMA / CNAS / 国家CMA）。

### 4.3 导出（export-service）

移植 bzxz `cap-lib-service.exportDiff` 的 xlsx 流式导出模式：

- **清单匹配结果导出**：每行一个标准号，列含「标准号 / 标准名 / 省级CMA /
  CNAS / 国家CMA / 一单一库 / 是否覆盖 / 检测项目」。状态列加文字前缀，便于 Excel 筛选。
- **综合查询结果导出**：当前查询结果平铺导出。
- **实现**：`xlsx@0.18.5` 生成 buffer，`res.send(buffer)` **流式不落临时文件**，
  `Content-Disposition: filename*=UTF-8''…`，首行 `!autofilter` + `!cols` 列宽自适应
  （中文 2 宽估算）。

### 4.4 REST API 端点设计

沿用 bzxz 约定：**Result 壳 `{ data, error }`**、`respond()`/`respondError()`、
请求体 zod camelCase、DB 出口 `toCamelCase()`、错误抛 `AppError` 子类。

```
# 健康检查
GET    /api/health

# 标准清单（匹配主线）
POST   /api/watchlists                导入清单（Excel 上传 multipart 或 JSON 标准号数组）
GET    /api/watchlists                清单列表
GET    /api/watchlists/:id            清单详情
DELETE /api/watchlists/:id            删除清单
GET    /api/watchlists/:id/match      执行匹配 → 返回 MatchResult[]
POST   /api/watchlists/:id/export     导出匹配结果 Excel

# 综合查询（资质库直查）
GET    /api/qualifications/search          关键词行级搜索（?q=&sources=&page=）
GET    /api/qualifications/by-standard      按标准号聚合搜索
POST   /api/qualifications/export           导出查询结果

# 省级 CMA / CNAS 在线抓取
GET    /api/sources/prov_cma/search         省级 CMA 按机构名搜候选
POST   /api/sources/prov_cma/subscribe      订阅省级 CMA 机构
POST   /api/sources/prov_cma/sync           抓取省级 CMA 明细
GET    /api/sources/cnas/presets            内置 CNAS 机构列表
POST   /api/sources/cnas/subscribe          订阅 CNAS 机构
POST   /api/sources/cnas/sync               抓取 CNAS 明细
GET    /api/sources/sync-progress/:jobId    抓取进度轮询
GET    /api/sources/:source/orgs            本机构在某机构型源的本地概况

# 一单一库（领域型）
GET    /api/cap-lib/domains                 11 领域订阅状态
PUT    /api/cap-lib/domains/:domain/subscribe 订阅/退订领域
POST   /api/cap-lib/domains/:domain/sync    同步某领域
GET    /api/cap-lib/sync-progress/:jobId    一单一库同步进度
POST   /api/cap-lib/cleanup                 清理 N 天未见孤儿行

# 资质明细导入（首版主路径）
POST   /api/import/qualifications           Excel 导入资质明细（指定 source）

# 系统设置 / 备份
GET    /api/system/overview                 设置页数据总览
GET    /api/system/settings                 CNAS 设置读取
PUT    /api/system/settings                 CNAS 设置写入
GET    /api/system/backup                   下载 SQLite 备份
```

> **无 auth/admin 路由**（单用户无登录）。所有写操作直接执行，不做 tab 权限。
> 这是相比 bzxz 最大的简化——省掉 `auth-middleware` / `requireTab` / `users` / `sessions` 整套。

### 4.5 错误处理与并发

- **错误**：3 条路径合一（zod 校验错 / 业务 `AppError` / 意外异常），全局错误中间件
  统一转 Result error 壳。禁止把失败塞进 HTTP 200。
- **并发**：单用户场景，主要的并发保护是**抓取入库串行队列**（防事件循环锁死）+
  CNAS 页面池信号量。HTTP 出站用 undici 连接池（移植 bzxz `shared/http.ts`）。

---

## 第 5 节 · 前端设计

> Vue 3 + Vite + TypeScript + Element Plus + Pinia。SPA，开发期 Vite proxy 转发
> `/api` 到后端，生产期后端 Express 托管 `web/dist` 静态资源。

### 5.1 技术选型与理由

| 关注点 | 选型 | 理由 |
|--------|------|------|
| 框架 | Vue 3 `<script setup>` + TS | 工具类应用、表格表单为主，Vue 上手快、模板直观 |
| 构建 | Vite | 快、Vue 官方推荐、proxy 配置简单 |
| UI 库 | Element Plus | `el-table`（含排序/筛选/固定列）、`el-upload`、`el-pagination`、`el-tag` 开箱即用 |
| 状态 | Pinia | 清单/资质/同步进度跨页面共享 |
| 路由 | Vue Router | 4 个主页面 |
| HTTP | 原生 fetch 封装 | 统一解 Result 壳（移植 bzxz `readApiResponse` 思路） |
| 导出兜底 | xlsx（前端） | 后端导出为主；纯前端筛选结果可前端直接导出 |

### 5.2 页面结构（4 个主页面 + 侧边栏）

```
┌──────────┬────────────────────────────────────────┐
│          │                                        │
│ 侧边栏    │            主内容区                      │
│          │                                        │
│ 📋 清单匹配 │  ← 主线：导入清单 → 匹配 → 导出          │
│ 🔍 综合查询 │  ← 资质库关键词/标准号查询              │
│ 🗂 资质管理 │  ← 一单一库 / 省级CMA / CNAS 同步管理     │
│ ⚙️ 设置    │  ← 数据总览、CNAS 设置、全库备份          │
│          │                                        │
└──────────┴────────────────────────────────────────┘
```

#### 页面 1：清单匹配（核心）

```
┌─────────────────────────────────────────────────┐
│ [上传 Excel] [粘贴标准号] [我的清单 ▾]   [导出 ⬇]  │
├─────────────────────────────────────────────────┤
│ 清单名：xxx 清单   共 128 个标准   覆盖率 76%       │
├──────┬──────────┬────────┬──────┬───────┬────────┤
│标准号 │标准名     │省级CMA  │CNAS  │国家CMA │一单一库 │
├──────┼──────────┼────────┼──────┼───────┼────────┤
│GB/T..│xxx       │✓ 3机构  │✓ 1   │✓ 2    │🟢在库   │
│GB/T..│xxx       │—       │✓ 2   │—      │🟡仅引用 │
│GB/T..│xxx       │—       │—     │—      │⚪不在库  │← 未覆盖高亮
└──────┴──────────┴────────┴──────┴───────┴────────┘
点击单元格 → 展开抽屉看命中明细（哪些机构、检测项目、有效期）
```

- 上传走 `el-upload`，调 `POST /api/watchlists`（multipart）。
- 表格 `el-table`，3 个机构资质列 + 一单一库列用状态标签展示。
- 「未覆盖」行高亮（用户最关心哪些标准没人能做）。
- 顶部筛选：覆盖状态、关键词过滤；表头支持资质列状态筛选，服务端分页/排序。
- 导出按钮 → `POST /api/watchlists/:id/export` 下载 Excel。

#### 页面 2：综合查询

- 搜索框（标准号 / 关键词）+ 机构型源筛选（全部 / 省级CMA / CNAS / 国家CMA）。
- 两种视图切换：**行级列表** / **按标准号聚合**（产品标准可展开）。
- 分页（`el-pagination`）。结果可导出。

#### 页面 3：资质管理

- Tab 分 4 类源。每类：
  - 已订阅机构/领域列表（同步状态、记录数、上次同步时间）。
  - 一单一库：领域订阅、同步、清理孤儿行。
  - 省级 CMA：按机构名搜索候选，订阅并同步。
  - CNAS：内置本机构预设，订阅并同步。
  - 国家 CMA：在线抓取止损，占位提示走 Excel 导入降级。

#### 页面 4：设置

- 数据总览：三类机构型资质源、一单一库、标准清单数量与最近同步状态。
- CNAS 抓取设置：浏览器路径（可用现成 Chrome/Edge）与翻页节流间隔。
- 数据备份：下载 SQLite online backup 一致快照，用于迁移或备份。

### 5.3 组件拆分

```
web/src/
├── pages/
│   ├── MatchPage.vue          清单匹配
│   ├── SearchPage.vue         综合查询
│   ├── SourcesPage.vue        资质管理（含 4 个源子 tab）
│   └── SettingsPage.vue       设置
├── components/
│   ├── CoverageTag.vue        资质覆盖状态标签（统一色板）
│   ├── CapLibStatusTag.vue    一单一库 5 档状态标签
│   ├── SyncProgress.vue       同步进度条
│   └── QualImportDialog.vue   资质明细导入对话框
├── api/
│   ├── client.ts              fetch 封装 + Result 壳解包
│   ├── watchlist.ts
│   ├── qualification.ts
│   ├── cap-lib.ts
│   ├── sources.ts
│   └── system.ts
├── router.ts
└── main.ts
```

**色板单一真相源**：`CoverageTag` / `CapLibStatusTag` 的状态→颜色映射集中一处定义
（移植 bzxz `DIFF_STATUS_META` 思路），避免散落各组件不一致。

### 5.4 与后端的契约

- **Result 壳解包**：`api/client.ts` 统一处理 `{ data, error }`，error 时抛 `Error`
  带 `.code`，页面 `try/catch` 弹 `ElMessage`。
- **字段命名**：API 返回 camelCase，前端直接用，无需转换。
- **Vite proxy**（开发）：

```ts
// vite.config.ts
server: { proxy: { '/api': 'http://localhost:3000' } }
```

- **生产托管**：后端 `app.use(express.static('web/dist'))` + SPA fallback 到 `index.html`。

### 5.5 不做的事（相比 bzxz 砍掉）

- 无登录/注册/用户下拉/权限 tab 隐藏。
- 无标准检索/下载/预览/PDF 相关页面。
- 无 Electron 桌面端集成（reveal-in-folder、托盘等）。
- 无公告系统、使用统计页。
- 主题：首版用 Element Plus 默认主题即可，不移植 bzxz 的玻璃/OKLCH 主题体系
  （那是 bzxz 的重资产，新项目轻装上阵）。

---

## 第 6 节 · 实施路线图

> 分阶段交付，每阶段可独立验证。原则：**先把「导入 → 匹配 → 导出」主链路跑通（不依赖
> 任何抓取），再逐源接入抓取**。这样最高风险的国家 CMA 逆向不阻塞主流程。

### 6.1 阶段划分

#### 阶段 0 · 脚手架（地基）✅ 完成

- 初始化后端：`package.json`（Express5 + better-sqlite3 + cheerio + playwright + xlsx +
  zod + TS）、`tsconfig.json`、`src/index.ts`。
- 初始化前端：`web/`（Vite + Vue3 + Element Plus + Pinia + Router）。
- **移植 bzxz 共享层**（几乎零改动）：
  - `shared/std-code.ts` + 其单测（**最关键，地基中的地基**）
  - `shared/response.ts`（Result 壳）、`errors.ts`、`case.ts`、`http.ts`
- `services/db.ts`：建第 2 节全部表（三层归一列**一开始就写进 CREATE TABLE**）+
  `STD_CODE_ALGO_VERSION` 回填机制。
- 验证：后端起得来、`/api/health` 通、前端 `npm run dev` 出空壳页面、proxy 通。

#### 阶段 1 · 主链路（导入 → 匹配 → 导出，无抓取）✅ 完成

- `import-service`：Excel 解析 → 三层归一化 → 入资质明细表 + 清单表。
- `match-service`：批量 IN 查询匹配引擎（第 4.1 节）。
- `export-service`：匹配结果 xlsx 流式导出。
- API：`/api/watchlists/*`、`/api/import/qualifications`。
- 前端：`MatchPage` + `CoverageTag` + `CapLibStatusTag` + `QualImportDialog`。
- **验证（端到端）**：手工准备一份资质明细 Excel 导入 → 再导入一份标准清单 → 看到匹配
  结果表 → 导出 Excel 核对。**此时产品已可用**（数据靠手工导入）。

#### 阶段 2 · 综合查询 ✅ 完成

- `qualification-service`：行级搜索 + 按标准号聚合（带年/不带年分流）。
- API：`/api/qualifications/*`。
- 前端：`SearchPage`。
- 验证：关键词/标准号查本地库，结果正确、可导出。

#### 阶段 3 · 接入一单一库（最低风险抓取源）✅ 完成

- 移植 bzxz `cap-lib-service` + `cap-lib-domains` + `cap-lib-status`，并抽出 `sync-progress`
  供一单一库和抓取任务共用。
- API：`/api/cap-lib/*`。
- 前端：`SourcesPage` 的一单一库 tab + `SyncProgress`。
- 验证：订阅一个领域 → 同步 → 匹配结果里一单一库列出现 5 档状态。

#### 阶段 4 · 接入省级 CMA + CNAS（移植抓取器）✅ 完成

- 移植 `cma-scraper`（HTTP+cheerio）、`cnas-scraper`（playwright）。
- 用 `scrape-service` 做抓取结果映射、三层归一化、replace 入库。
- API：`/api/sources/{prov_cma,cnas}/*`（搜索/订阅/同步/进度）。
- 前端：资质管理对应 tab。
- 验证：省级 CMA 联网抓取 28110 条、CNAS 联网抓取 7451 条，均已入库并匹配命中。

#### 阶段 5 · 国家 CMA 在线抓取 ✅ 完成

- `poc/` 已验证滑块缺口直检与三层下钻链路，后端抓取器/service/routes 已接入。
- 前端 SourcesPage 国家 CMA tab 已支持搜索、订阅、同步和进度轮询。
- 设置页已提供国家 CMA 抓取开关、浏览器路径和节流配置。
- `/api/import/qualifications` 导入国家 CMA Excel 明细的降级路径仍保留。

#### 阶段 6 · 打磨 ✅ 完成

- 设置页：数据总览、CNAS/国家 CMA 浏览器路径、翻页节流配置和国家 CMA 抓取开关。
- 全库备份：SQLite online backup 一致快照下载。
- README + 部署说明：生产单端口托管、`playwright install`、Chrome/Edge 退路、备份/迁移说明。
- 匹配页：服务端分页、排序、关键词筛选、资质列状态筛选。
- 验证：`npm test`（65 个用例）、`npx tsc -p tsconfig.json --noEmit`、`npm run web:typecheck` 均通过。

### 6.2 复用清单（直接从 bzxz 搬）

| 文件 | 改动程度 | 说明 |
|------|---------|------|
| `shared/std-code.ts` + 单测 | 零改 | 三层归一化，地基 |
| `shared/response.ts` / `errors.ts` / `case.ts` / `http.ts` | 零改 | 通用工程层 |
| `shared/cap-lib-domains.ts` / `cap-lib-status.ts` | 零改 | 一单一库领域+5档状态 |
| `services/cap-lib-service.ts` | 小改 | 改表名 `cma_capability_lib`→`cap_lib`、去多用户 |
| `sources/prov-cma/cma-scraper.ts` | 中改 | HTTP+cheerio 机构搜索/详情/能力明细抓取 |
| `sources/cnas/cnas-scraper.ts` | 中改 | playwright + JSL 反爬能力明细抓取 |
| db 分块事务/串行队列模式 | 模式复用 | 防事件循环锁死 |

### 6.3 风险点

| 风险 | 等级 | 应对 |
|------|------|------|
| **国家 CMA 验证码 + 反爬 token** | 低 | 已解决：滑块缺口直检（Sobel）20/20 稳定，提交带 finalX。后端抓取器已通并联网验证 |
| 国家 CMA 数据接口形态未明 | 低 | 已查明：三层下钻 list→场所→formAbility，按场所分页抓全量明细 |
| std_code 归一化漏命中 | 中 | 直接移植 bzxz 成熟实现 + 单测，不重写 |
| playwright 在目标机器安装/运行 | 中 | README 写明 `npx playwright install chromium`；当前仅 CNAS 在线抓取需要 |
| Excel 导入列格式不统一 | 低 | 提供导入模板 + 列映射校验，无年号/空号行跳过并回报 |

### 6.4 首版 MVP 范围（建议）

**MVP = 阶段 0 + 1 + 2 + 3**：

- 导入资质明细（Excel）+ 导入标准清单 → 匹配 → 导出。
- 综合查询。
- 一单一库自动同步（零风险抓取源）。

当前产品已超过 MVP：省级 CMA / CNAS 支持在线抓取并已联网验证；国家 CMA 走 Excel 导入降级；
一单一库自动同步；设置页和全库备份已落地。

### 6.5 验证策略

- 关键归一化逻辑写**单元测试**（`std-code` / 匹配引擎 / 一单一库 5 档 / 阶段 6 设置服务）。
- 主链路用一份**真实标准清单 + 一份资质明细 Excel** 做端到端冒烟。
- 省级 CMA / CNAS 抓取源已用本机构数据做联网验证；国家 CMA 只验证 Excel 导入降级链路。

---

> **文档完成并已同步当前代码状态（2026-06-07）**。后续继续以本文档作为单一真相源，
> 代码与文档同步更新。
