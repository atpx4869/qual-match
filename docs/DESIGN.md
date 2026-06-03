# qual-match 设计文档

> 资质匹配核查工具 —— 导入标准清单，比对省级 CMA / CNAS / 国家 CMA / 一单一库四类资质，
> 支持资质本地保存、综合查询、结果导出。
>
> 本程序是 `bzxz`（标书系统）资质模块的独立缩小版。后续会成为独立仓库。**仅 Web，无桌面客户端。**
>
> **设计文档 6 节已全部完成**。实施进度（按 §6.1）：✅ 阶段 0 脚手架 + ✅ 阶段 1 主链路 +
> ✅ 阶段 2 综合查询 + ✅ 阶段 3 一单一库自动同步（MVP 闭环）+ 🟡 阶段 4 省级 CMA/CNAS 抓取
> （代码完成，省级 CMA 已联网验证 28110 条，CNAS 待补验证，2026-06-04）。
> 下一步：补 CNAS 联网验证 → 阶段 6 打磨。

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
┌─────────────┐   导入/手填    ┌──────────────┐   交叉匹配    ┌──────────────┐
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
                          │ ├────────┼───────────┤  │  ◀── 抓取/导入/手填 写入
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
| 动态渲染抓取 | playwright（CNAS / 国家 CMA 验证码场景） | bzxz cnas-scraper |
| 验证码 OCR | ddddocr 子进程 / tesseract.js 回退 | bzxz captcha-ocr |
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
│  │ sources/    数据源层：4 个资质源适配器（统一接口）     │  │
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
│   │   ├── qualification-routes.ts 资质机构管理 + 综合查询
│   │   ├── source-routes.ts      各源同步/订阅
│   │   └── health-routes.ts
│   ├── services/
│   │   ├── match-service.ts      ★ 清单 × 4 资质交叉匹配引擎
│   │   ├── qualification-service.ts 4 类资质本地库 CRUD + 综合查询
│   │   ├── sync-service.ts       抓取同步编排（串行化 + 进度）
│   │   ├── import-service.ts     Excel 导入（清单 + 资质明细）
│   │   ├── export-service.ts     匹配结果 / 查询结果导出 Excel
│   │   └── db.ts                 schema + 迁移 + 归一化回填
│   ├── sources/                  4 个资质数据源适配器
│   │   ├── source.ts             QualSourceAdapter 统一接口
│   │   ├── prov-cma/             省级 CMA（移植 bzxz cma-scraper）
│   │   ├── cnas/                 CNAS（移植 bzxz cnas-scraper）
│   │   ├── nat-cma/              国家 CMA（★ 新写，cma.cnca.cn）
│   │   └── cap-lib/              一单一库（移植 bzxz cap-lib-service）
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
│   │   ├── components/           表格、上传、徽章、状态标签
│   │   ├── api/                  fetch 封装（解 Result 壳）
│   │   ├── stores/               Pinia 状态
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
  data_origin    TEXT DEFAULT 'manual',      -- manual(导入/手填) / scraped(抓取)
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

`settings` 存什么：库路径、各源默认同步并发、国家 CMA 抓取开关等。无 localStorage 之外的
UI 偏好仍走前端 localStorage（沿用 bzxz 三层配置约定的简化版：DB settings + 前端 localStorage，
无 Electron 层）。

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

### 3.1 统一数据源接口

四类源最终都要把数据写进本地库，抽象一个统一接口让 sync-service 编排：

```ts
// src/sources/source.ts
export interface QualSourceAdapter {
  readonly id: 'prov_cma' | 'cnas' | 'nat_cma' | 'cap_lib';
  readonly label: string;

  /** 按机构标识（或领域）抓取明细。返回归一化前的原始能力行。 */
  fetchCapabilities(
    target: string,                       // 机构标识 / 领域名
    onProgress?: (fetched: number, total: number) => void,
  ): Promise<RawCapability[]>;

  /** （机构型可选）按名称搜索候选机构，供订阅前选择。 */
  searchOrgs?(query: string): Promise<OrgCandidate[]>;
}

// 各源抓取产出的中间形态，由 sync-service 统一做三层归一化后入库
export interface RawCapability {
  stdCode: string;          // 原始标准号（入库前过 cleanStdCode）
  stdName?: string;
  category?: string;
  testObject?: string;
  testParam?: string;
  testStandard?: string;
  limitDesc?: string;
  effectiveDate?: string;
  expiryDate?: string;
  // 源专属字段放 extra，入库时映射到对应列
  extra?: Record<string, string>;
}
```

> **不强抽基类**（沿用 bzxz §六 教训）：各源能力差异是业务本质。接口只约定「最终产出
> `RawCapability[]`」，抓取过程各源自由实现。一单一库无「机构」概念，`fetchCapabilities`
> 的 target 传领域名。

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
- **改造**：去掉 bzxz 的「更新检测 checkForUpdate」可选保留；适配新 `RawCapability` 形态。
- **机构标识**：`cert_number`；抓取定位字段 `public_detail_id`。

### 3.4 CNAS（移植 bzxz `cnas-scraper.ts`）

- **来源**：bzxz 现有 CNAS 抓取，基于 **playwright**（CNAS 站点需浏览器渲染）。
- **关键复用**：`CnasScraper` 的**页面池**（共享 browser + 每任务独立 context/page +
  信号量 `maxConcurrent=3`）。直接移植，单用户场景下并发压力更小。
- **机构标识**：`lab_no`；抓取定位字段 `base_info_id` + `url_params`。
- **playwright 依赖**：新项目 package.json 需带 playwright；首次运行需
  `npx playwright install chromium`。README 写明。

### 3.5 国家 CMA（★ 新写，`cma.cnca.cn`）

**已实测探明的事实**（构思阶段用 playwright 实地勘察 + 抓包确认）：

- 接口：`POST http://cma.cnca.cn/cma/solr/tBzAbilitySearch/list`
- 站点：JSP 老站（朗赢科技 longwi.com），Bootstrap 2.3.1 + jQuery 3.4.1 前端。
- **表单参数**（已抓到真实字段名）：
  `pageNo` / `pageSize` / `certCode`（证书编号）/ `abilityStandardCode`（标准编号）/
  `applyOrgName`（机构名称）/ `abilityStandardName`（标准名称）/ `abilityItemName`
  （产品/项目/参数）/ `abilityParentName`（大类）/ `abilityTypeName`（类别）/
  `applyFieldCode`（所属领域，22 个）/ `applySectorBoard`（评审组，34 个）/
  `placeAddressDetail`（场所地址，34 省）/ `applyId` / `placeId` / `flag`。
- **结果表字段**：序号 / 证书号 / 机构名称 / 场所地址 / 机构联系人 / 联系方式 / 操作。
  结果表 `#contentTable` 由前端 JS（mustache 模板）渲染。

**⚠️ 关键障碍：滑块验证码（已确证，非图形验证码）**

点「查询」会触发 `GET /cma/base/tBaRegistered/getSliderCaptcha`，弹出**缺口拼图滑块**。
实测该接口返回 JSON：

```json
{ "slider": "<base64 PNG 滑块小图>", "bg": "<base64 PNG 背景大图(带缺口)>", "y": 16 }
```

- `bg` 是 300px 宽背景图，缺口在某个 X 坐标（实测样本缺口约在图宽 22% 处）。
- `slider` 是对应拼图块；`y` 给定纵向固定位置 —— **只需求解 X 方向缺口偏移**。
- 这是业界最常见的「缺口滑块」，**技术上可破解**（非验证码识别难题）。

**滑块破解方案（实施阶段，自研轻量算法，不依赖第三方打码）：**

1. **缺口定位**：拿到 `bg` 后做图像处理找缺口 X 坐标。两条可选路径：
   - 边缘检测（Canny/Sobel）找缺口轮廓的左边界 —— 缺口边缘对比度高、易定位。
   - 模板匹配：用 `slider` 块在 `bg` 上滑动算相似度峰值（OpenCV `matchTemplate` 思路）。
   - Node 侧可用 `sharp` 或 `jimp` 做像素级处理；必要时起一个小 Python 子进程
     （仿 bzxz 的 ddddocr 子进程模式，`captcha-ocr.ts` 已有现成的子进程多路复用框架可抄）。
2. **轨迹模拟**：playwright 按算出的 X 距离拖拽滑块，加**仿人加速度曲线 + 微小抖动**
   （匀加速→减速 + 随机噪声），过行为检测。
3. **校验提交**：滑块通过后页面才真正发 `tBzAbilitySearch/list` 请求并渲染结果。
   验证态保存在 session cookie 里 —— **过一次码后短时间内多次分页查询复用同一 session**
   （仿 bzxz labr 的 session 持久化），把过码成本摊薄到一批查询上。

**抓取链路（playwright 为主）：**

- 国家 CMA 必须走 **playwright**（滑块要真实浏览器拖拽 + session cookie）。复用 bzxz
  `cnas-scraper` 的**页面池 + 信号量**框架（共享 browser + 每任务 context/page）。
- 单源信号量钉死低并发（如 `nat_cma=1~2`）—— 政府站点频控敏感 + 过码有成本，不宜高并发。
- 拿到验证 session 后，按 `certCode` 分页拉（`pageNo`/`pageSize`）该机构全部能力行，
  cheerio 解析渲染后的 `#contentTable` DOM（或拦截 mustache 的数据源 XHR 直接取 JSON）。

**机构标识**：`cert_number`（如示例 `230020349767`）。

**风险与降级**：滑块算法是国家 CMA 抓取成败的关键单点。**降级路径**：阶段 5 若滑块破解
不稳定，国家 CMA 数据退回「Excel 导入 / 手填」（与其他源同一张明细表、同一匹配引擎），
不阻塞产品可用性 —— 这正是「抓取后置」策略的价值所在。

### 3.6 一单一库（移植 bzxz `cap-lib-service.ts`）

- **来源**：`https://cma.caqit.org.cn/cma-admin/system/standardData/list`，无鉴权。
- **整套移植**：11 个顶层领域常量、分页拉取（`pageSize=2000` 逐页）、同步串行化
  （`syncChain` 并发 1）、hash diff + soft delete、5 档比对状态解析。
- **领域常量**：`shared/cap-lib-domains.ts` 与 db schema 的领域初始化数组手动保持一致。
- 这是四源里最成熟、风险最低的，几乎零改动移植。

### 3.7 同步编排（sync-service）

```ts
// src/services/sync-service.ts —— 统一编排 4 类源的抓取入库
class SyncService {
  // 机构型：抓取单个机构 → 三层归一化 → 分块事务替换该机构旧数据
  async syncOrg(source, target, force): Promise<{ records: number }>;
  // 一单一库：按领域分页拉 → hash diff upsert（移植 bzxz runSync）
  async syncDomain(domain): Promise<SyncStats>;
  // 进度：内存 Map<sourceTargetKey, {fetched,total}>，前端轮询
}
```

**串行化原则**（移植 bzxz）：所有入库走模块级串行队列，避免多个大事务连环锁死事件循环。
单用户场景并发本就低，串行更安全。

### 3.8 导入 / 手填（首版主路径）

抓取后置，所以首版资质数据主要靠**导入**：

- **Excel 导入资质明细**：用户准备一份含「标准号 / 标准名 / 检测项目 / 机构 / 有效期」等
  列的 Excel，`import-service` 用 xlsx 解析 → 三层归一化 → 入对应源的明细表。
  导入时指定 source + 机构标识。
- **手工录入**：前端表单逐条加资质（少量补录场景）。
- 导入的行 `data_origin='manual'`，与抓取行（`scraped`）区分，便于后续清理/覆盖。

> 导入与抓取产出同一张明细表、同样过三层归一化，所以匹配引擎对「导入的」和「抓来的」
> 资质一视同仁。

---

## 第 4 节 · 匹配引擎与 API

### 4.1 匹配引擎（match-service）—— 核心

输入：一份清单的标准号集合。输出：每个标准号在 4 类资质中的覆盖情况。

**算法（参照 bzxz `queryByStdCodes` 的批量 IN 查询）：**

```
1. 取清单全部 std_code_norm（保年归一）+ std_code_base（剥年归一），去重。
2. 一次性批量查 4 类资质库：
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
  // 4 类资质各自的命中
  provCma: QualHit[];         // 省级 CMA 命中（哪些机构持有）
  cnas:    QualHit[];
  natCma:  QualHit[];
  capLib:  CapLibStatus;      // 一单一库 5 档状态（in_lib/cite_only/abolished/series_only/not_in_lib）
  // 汇总
  coveredBy: ('prov_cma'|'cnas'|'nat_cma'|'cap_lib')[];  // 被哪几类覆盖
  matched: boolean;           // 是否至少被一类覆盖
}
interface QualHit {
  labNo: string;
  labName: string;
  testItem: string;           // 检测项目（聚合展示）
  effectiveDate: string;
  expiryDate: string;
}
```

**性能**：清单规模有限（首版上限建议 500 标准），4 张表各一次 `IN` 索引查询，
总计个位数 SQL、毫秒级。无需缓存表（第 2.4 节）。

### 4.2 综合查询（qualification-service）

独立于清单的关键词/标准号查询，参照 bzxz `searchQualifications` + `searchByStandard`：

- **行级搜索**：关键词命中标准号 / 标准名 / 机构名 / 检测项目，跨 4 源 `UNION`，分页返回。
- **按标准号聚合**：同一标准号下的全部资质行聚合成一组（产品标准可展开看完整覆盖）。
- **带年/不带年分流**（移植 bzxz）：用户输入带 4 位年份 → 严格保年；不带年 → 保年+剥年双路径。
- **源过滤**：可只查某一类资质（省级CMA / CNAS / 国家CMA / 一单一库）。

### 4.3 导出（export-service）

移植 bzxz `cap-lib-service.exportDiff` 的 xlsx 流式导出模式：

- **清单匹配结果导出**：每行一个标准号，列含「标准号 / 标准名 / 省级CMA覆盖机构 /
  CNAS覆盖机构 / 国家CMA覆盖机构 / 一单一库状态 / 是否覆盖」。状态列加 emoji/文字前缀。
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
GET    /api/qualifications/search          关键词行级搜索（?q=&source=&page=）
GET    /api/qualifications/by-standard      按标准号聚合搜索
POST   /api/qualifications/batch-query      批量按标准号查（供前端徽章/外部调用）
POST   /api/qualifications/export           导出查询结果

# 资质机构管理（4 类源）
GET    /api/sources/:source/orgs            列出已订阅机构（source: prov_cma/cnas/nat_cma）
POST   /api/sources/:source/orgs            订阅机构（手填标识 或 选搜索候选）
DELETE /api/sources/:source/orgs/:id        取消订阅（删机构+明细）
GET    /api/sources/:source/orgs/search     按名称搜候选机构（抓取器支持时）
POST   /api/sources/:source/orgs/:id/sync   抓取/同步该机构明细
GET    /api/sources/:source/sync-progress   同步进度轮询

# 一单一库（领域型）
GET    /api/cap-lib/domains                 11 领域订阅状态
POST   /api/cap-lib/domains/:domain/sync    同步某领域
POST   /api/cap-lib/cleanup                 清理 N 天未见孤儿行

# 资质明细导入（首版主路径）
POST   /api/import/qualifications           Excel 导入资质明细（指定 source + 机构）

# 配置
GET    /api/settings
PUT    /api/settings
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
│ 🗂 资质管理 │  ← 4 类源机构订阅/同步/导入             │
│ ⚙️ 设置    │  ← 库路径、同步并发等                   │
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
- 表格 `el-table`，4 个资质列用 `el-tag` 显示命中数 + 状态色。
- 「未覆盖」行高亮（用户最关心哪些标准没人能做）。
- 顶部筛选：只看未覆盖 / 只看某类资质覆盖 / 关键词过滤。
- 导出按钮 → `POST /api/watchlists/:id/export` 下载 Excel。

#### 页面 2：综合查询

- 搜索框（标准号 / 关键词）+ 源筛选（全部 / 省级CMA / CNAS / 国家CMA / 一单一库）。
- 两种视图切换：**行级列表** / **按标准号聚合**（产品标准可展开）。
- 分页（`el-pagination`）。结果可导出。

#### 页面 3：资质管理

- Tab 分 4 类源。每类：
  - 已订阅机构/领域列表（同步状态、记录数、上次同步时间）。
  - 「添加机构」：手填标识 或 搜索候选（抓取器支持时）。
  - 「导入 Excel」：导入该源资质明细（首版主路径）。
  - 「同步」按钮（抓取器接入后可用）→ 进度条轮询 `sync-progress`。

#### 页面 4：设置

- 数据库/库路径展示，各源同步并发，国家 CMA 抓取开关等。

### 5.3 组件拆分

```
web/src/
├── pages/
│   ├── MatchPage.vue          清单匹配
│   ├── SearchPage.vue         综合查询
│   ├── SourcesPage.vue        资质管理（含 4 个源子 tab）
│   └── SettingsPage.vue       设置
├── components/
│   ├── StdCodeUpload.vue      Excel 上传 / 粘贴标准号
│   ├── MatchTable.vue         匹配结果表（4 资质列）
│   ├── QualHitDrawer.vue      命中明细抽屉
│   ├── CoverageTag.vue        资质覆盖状态标签（统一色板）
│   ├── CapLibStatusTag.vue    一单一库 5 档状态标签
│   ├── OrgList.vue            机构订阅列表（资质管理复用）
│   ├── SyncProgress.vue       同步进度条
│   └── QualImportDialog.vue   资质明细导入对话框
├── stores/
│   ├── watchlist.ts           清单 + 匹配结果
│   ├── qualification.ts       综合查询状态
│   └── sources.ts             4 类源机构/同步状态
├── api/
│   ├── client.ts              fetch 封装 + Result 壳解包
│   ├── watchlist.ts
│   ├── qualification.ts
│   └── sources.ts
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

#### 阶段 0 · 脚手架（地基）

- 初始化后端：`package.json`（Express5 + better-sqlite3 + cheerio + playwright + xlsx +
  zod + TS）、`tsconfig.json`、`src/index.ts`。
- 初始化前端：`web/`（Vite + Vue3 + Element Plus + Pinia + Router）。
- **移植 bzxz 共享层**（几乎零改动）：
  - `shared/std-code.ts` + 其单测（**最关键，地基中的地基**）
  - `shared/response.ts`（Result 壳）、`errors.ts`、`case.ts`、`http.ts`
- `services/db.ts`：建第 2 节全部表（三层归一列**一开始就写进 CREATE TABLE**）+
  `STD_CODE_ALGO_VERSION` 回填机制。
- 验证：后端起得来、`/api/health` 通、前端 `npm run dev` 出空壳页面、proxy 通。

#### 阶段 1 · 主链路（导入 → 匹配 → 导出，无抓取）

- `import-service`：Excel 解析 → 三层归一化 → 入资质明细表 + 清单表。
- `match-service`：批量 IN 查询匹配引擎（第 4.1 节）。
- `export-service`：匹配结果 xlsx 流式导出。
- API：`/api/watchlists/*`、`/api/import/qualifications`。
- 前端：`MatchPage` + `StdCodeUpload` + `MatchTable` + `QualImportDialog`。
- **验证（端到端）**：手工准备一份资质明细 Excel 导入 → 再导入一份标准清单 → 看到匹配
  结果表 → 导出 Excel 核对。**此时产品已可用**（数据靠手工导入）。

#### 阶段 2 · 综合查询

- `qualification-service`：行级搜索 + 按标准号聚合（带年/不带年分流）。
- API：`/api/qualifications/*`。
- 前端：`SearchPage`。
- 验证：关键词/标准号查本地库，结果正确、可导出。

#### 阶段 3 · 接入一单一库（最低风险抓取源）

- 移植 bzxz `cap-lib-service` + `cap-lib-domains` + `cap-lib-status` + `sync-service`
  的领域同步部分。
- API：`/api/cap-lib/*`。
- 前端：`SourcesPage` 的一单一库 tab + `SyncProgress`。
- 验证：订阅一个领域 → 同步 → 匹配结果里一单一库列出现 5 档状态。

#### 阶段 4 · 接入省级 CMA + CNAS（移植抓取器）

- 移植 `cma-scraper`（HTTP+cheerio）、`cnas-scraper`（playwright 页面池）。
- 适配 `QualSourceAdapter` 接口 + `RawCapability` 形态。
- API：`/api/sources/{prov_cma,cnas}/*`（搜索/订阅/同步/进度）。
- 前端：资质管理对应 tab。
- 验证：搜机构 → 订阅 → 抓取 → 明细入库 → 匹配/查询能命中抓来的资质。

#### 阶段 5 · 攻坚国家 CMA（★ 最高风险，新写）

- **逆向 `cma.cnca.cn`**（第 3.5 节待办）：
  1. playwright 开 `tBzAbilitySearch/list`，看 XHR 找真实数据接口。
  2. 判定验证码触发条件；需要则接 bzxz 的 `captcha-ocr`（ddddocr/tesseract）。
  3. 摸清 `finalX` 等反爬 token 生成逻辑。
- 实现 `nat-cma` adapter（优先纯接口，兜底 playwright）。
- 用示例证书 `230020349767` 验证：抓到该机构能力明细、入库、可匹配。

#### 阶段 6 · 打磨

- 设置页、同步并发配置、错误提示完善。
- README + 部署说明（含 `playwright install`）。
- 数据备份/导出全库（可选）。

### 6.2 复用清单（直接从 bzxz 搬）

| 文件 | 改动程度 | 说明 |
|------|---------|------|
| `shared/std-code.ts` + 单测 | 零改 | 三层归一化，地基 |
| `shared/response.ts` / `errors.ts` / `case.ts` / `http.ts` | 零改 | 通用工程层 |
| `shared/cap-lib-domains.ts` / `cap-lib-status.ts` | 零改 | 一单一库领域+5档状态 |
| `services/cap-lib-service.ts` | 小改 | 改表名 `cma_capability_lib`→`cap_lib`、去多用户 |
| `services/cma-scraper.ts` | 中改 | 适配新 adapter 接口 + RawCapability |
| `services/cnas-scraper.ts` | 中改 | 同上，保留页面池 |
| `sources/shared/captcha-ocr.ts` | 零改 | 国家 CMA 过码时用 |
| db 分块事务/串行队列模式 | 模式复用 | 防事件循环锁死 |

### 6.3 风险点

| 风险 | 等级 | 应对 |
|------|------|------|
| **国家 CMA 验证码 + 反爬 token** | 高 | 抓取后置（阶段 5），主链路不依赖；过码复用 bzxz OCR；最坏退化为手工导入 |
| 国家 CMA 数据接口形态未明 | 中 | 阶段 5 先逆向再实现，构思已留接口位 |
| std_code 归一化漏命中 | 中 | 直接移植 bzxz 成熟实现 + 单测，不重写 |
| playwright 在目标机器安装/运行 | 中 | README 写明 `npx playwright install chromium`；CNAS/国家CMA 才需要 |
| Excel 导入列格式不统一 | 低 | 提供导入模板 + 列映射校验，无年号/空号行跳过并回报 |

### 6.4 首版 MVP 范围（建议）

**MVP = 阶段 0 + 1 + 2 + 3**：

- 导入资质明细（Excel/手填）+ 导入标准清单 → 匹配 → 导出。
- 综合查询。
- 一单一库自动同步（零风险抓取源）。

此时产品**完全可用**：省级CMA/CNAS/国家CMA 的数据先靠 Excel 导入，一单一库自动同步。
省级CMA/CNAS/国家CMA 的在线抓取（阶段 4/5）作为后续增强迭代上线。

### 6.5 验证策略

- 沿用 bzxz：关键归一化逻辑写**单元测试**（`std-code` / 匹配引擎）。
- 主链路用一份**真实标准清单 + 一份资质明细 Excel** 做端到端冒烟。
- 抓取源各自接入后，用已知机构（如国家 CMA `230020349767`）核对抓取结果条数与官网一致。

---

> **文档完成**。6 节已全部写完：概述与架构 / 数据模型 / 数据源层 / 匹配引擎与 API /
> 前端设计 / 实施路线图。后续进入编码时，本文档作为单一真相源，代码与文档同步更新。





