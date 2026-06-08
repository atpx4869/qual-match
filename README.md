# qual-match · 资质匹配核查工具

某检测机构的「资质自查」工具：导入一份标准清单（Excel），查清单里的标准**本机构能做哪些、
不能做哪些** —— 即每个标准是否被本机构的 **省级 CMA / CNAS / 国家 CMA / 一单一库** 资质覆盖。
支持本地保存、综合查询、结果导出。

> 本项目是 `bzxz` 标书系统资质模块的独立缩小版。**仅 Web，无桌面客户端。**
> - 完整设计：[`docs/DESIGN.md`](docs/DESIGN.md)（6 节：概述 / 数据模型 / 数据源 / 匹配引擎与 API / 前端 / 路线图）
> - **续接开发先读**：[`docs/HANDOFF.md`](docs/HANDOFF.md)（当前进度 + 怎么跑 + 代码地图 + 下一步）

## 技术栈

| 层 | 选型 |
|----|------|
| 后端 | Node.js ≥20 + TypeScript（CommonJS）+ Express 5 + better-sqlite3 |
| 前端 | Vue 3 + Vite + Element Plus + Pinia + Vue Router（纯 Web SPA） |
| 抓取 | cheerio（HTTP）/ playwright（动态渲染）—— 阶段 4/5 接入 |
| 其他 | zod（校验）/ xlsx（Excel 读写）/ undici（HTTP 连接池） |

## 项目结构

```
qual-match/
├── src/                     后端（CommonJS）
│   ├── shared/              std-code 归一化 / Result 壳 / 错误 / case 转换 / http 池 / env / fs
│   ├── services/            db.ts（SQLite schema + 迁移 + 归一化回填）
│   ├── api/                 app.ts（Express 装配）/ health-routes.ts
│   └── index.ts             启动入口
├── web/                     前端（Vue 3 + Vite，ESM）
│   └── src/                 main.ts / App.vue / router.ts / pages/
├── data/                    运行时 SQLite 库（gitignored）
├── docs/DESIGN.md           设计文档（单一真相源）
└── poc/                     国家 CMA 滑块抓取 PoC（已打通，见 DESIGN §3.5 / `nat_cma_online_scraper.py`）
```

## 开发起步

```bash
# 1. 安装后端依赖（含 better-sqlite3 原生编译，需 Node ≥20）
npm install

# 2. 安装前端依赖
npm --prefix web install

# 3. 起后端（默认 3000，端口占用时自动回退随机端口）
npm run dev

# 4. 另开终端起前端（5173，/api 经 Vite proxy 转发到 3000）
npm run web:dev
# 浏览器开 http://localhost:5173 → 点「测试后端连通」验证链路
```

> playwright 浏览器内核（抓取阶段才需要）首次用前需 `npx playwright install chromium`，
> 阶段 0/1/2/3 不需要。

## 常用命令

| 命令 | 作用 |
|------|------|
| `npm run dev` | tsx 直跑后端（开发） |
| `npm run build` | tsc 编译后端到 `dist/` |
| `npm start` | 跑编译产物 `node dist/src/index.js` |
| `npm test` | vitest 跑后端单测（std-code 归一化等） |
| `npm run web:dev` | 起前端 Vite dev server |
| `npm run web:build` | 构建前端到 `web/dist/`（生产由后端 Express 静态托管 + SPA fallback） |
| `npm run web:typecheck` | 前端 vue-tsc 类型检查 |

## 凭据约定

抓取源账号密码通过仓库根 `.env.local`（gitignored）注入，键名 `<SOURCE>_USERNAME` /
`<SOURCE>_PASSWORD`，**绝不写进代码 / 文档 / 提交**。拷贝 `.env.example` 为 `.env.local` 填值。

## 部署（生产）

单进程部署：后端 Express 同时托管前端构建产物，**无需单独前端服务器**。

```bash
# 1. 安装依赖（后端 better-sqlite3 需 Node ≥20 原生编译）
npm install
npm --prefix web install

# 2. 构建前端 → web/dist/（后端启动时若检测到该目录即静态托管 + SPA fallback）
npm run web:build

# 3.（仅用 CNAS 在线抓取时）装 playwright 浏览器内核
npx playwright install chromium
#   下载受限环境改用现成 Chrome：设置页填「浏览器路径」或设环境变量 CNAS_CHROME_PATH
#   指向现成 chrome.exe（如 C:/Program Files/Google/Chrome/Application/chrome.exe）。

# 4. 起服务（默认 3000；编译产物方式见「常用命令」的 build/start）
npm run dev
#   浏览器开 http://localhost:3000 （生产单端口，前后端同源，无需 Vite proxy）
```

**端口**：后端固定 3000（开发期前端 5173 经 Vite proxy 转发 `/api` 到 3000）；
生产单端口 3000 直出 SPA。

**数据备份**：设置页「数据备份」可一键下载整库 sqlite 快照（用 SQLite online backup，
WAL 一致）；迁移时把下载的 `.db` 放回目标机 `data/qual-match.db` 即可。

**运行参数**：设置页可调 CNAS 浏览器路径与抓取节流间隔（存 settings 表）。
改浏览器路径后需重启服务生效（浏览器实例为进程内共享单例）。

> ⚠️ **Windows 端口残留**：tsx 子进程 Ctrl-C 可能杀不净，残留占用 3000。重启前若报端口占用：
> `netstat -ano | grep ":3000.*LISTENING"` 找 PID → `taskkill //F //PID <pid>`。
> playwright 抓取后还可能留 chrome 进程：`taskkill //F //IM chrome.exe`。

## 实施进度（按 DESIGN §6.1）

- [x] **阶段 0 · 脚手架**：前后端可运行骨架 + shared 共享层移植 + 全部 12 张表建库 + health 连通
- [x] **阶段 1 · 主链路**：导入本机构资质明细（Excel）+ 导入标准清单（Excel/粘贴）→ 匹配 → 导出。
  **单一机构定位**：本工具服务「本机构自查」，匹配结果回答「本机构某类资质（省级CMA/CNAS/国家CMA）
  有没有这个标准的能力」（✓有/—无/~仅其他年版），保年优先剥年兜底。
- [x] **阶段 2 · 综合查询**：独立于清单，直查本地资质库。关键词命中标准号/标准名/检测项目，
  跨 3 机构源 UNION；行级列表 + 按标准号聚合双视图；带年/不带年分流；源过滤；结果导出 Excel。
- [x] **阶段 3 · 一单一库自动同步**：移植 bzxz cap-lib，按领域订阅 → RuoYi 分页同步
  （hash diff + soft delete）→ 匹配引擎接入 5 档比对（在库/仅引用/已废止/仅系列/不在库）。
- [x] **阶段 4 · 省级 CMA + CNAS 抓取**：移植 bzxz 抓取器。省级 CMA（HTTP+cheerio）
  搜机构 → 抓取入库，**已联网验证 28110 条**；CNAS（playwright+JSL 反爬）搜机构 → 抓取入库，
  **已联网验证 7451 条**。两源均经匹配命中验证。
  （下载受限环境可设 `CNAS_CHROME_PATH` 用现成 Chrome，免下载 playwright 自带 chromium。）
- [x] **阶段 5 · 国家 CMA 在线抓取**：原滑块「止损」已翻案（2026-06-08）。滑块缺口直检（Sobel）
  20/20 稳定 + 三层下钻（list 机构 → 场所 → formAbility 明细，提交带 finalX）+ 按场所遍历。
  后端抓取器/service/路由已落地并联网验证（实测 5 场所 10955 条）；前端国家 CMA tab 已接入
  机构搜索 → 场所列表弹窗 → 场所订阅 → 同步/进度。
  Excel 导入降级仍保留。
  （同 CNAS，下载受限环境可设 `NAT_CMA_CHROME_PATH` 用现成 Chrome。）
- [x] **阶段 6 · 打磨**：设置页（数据总览 + CNAS/国家 CMA 浏览器路径/节流可配 + 国家 CMA 开关 + 全库备份下载）、部署说明。

**MVP = 阶段 0+1+2+3**：导入资质明细/清单 → 匹配 → 导出 + 综合查询 + 一单一库同步。
当前 **阶段 0~6 已完成，超出 MVP**：4 类资质源齐全，一单一库自动同步，省级 CMA / CNAS / 国家 CMA
均支持在线抓取并已联网验证（国家 CMA 前后端均已接入，Excel 导入降级仍保留）。
导入/同步/抓取 → 匹配 → 导出 + 综合查询全可用。
