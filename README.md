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
└── poc/                     国家 CMA 滑块破解 PoC（已止损，走导入降级，见 DESIGN §3.5）
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
- [ ] 阶段 5 · 国家 CMA（滑块破解已止损 → 走 Excel 导入降级）
- [ ] 阶段 6 · 打磨

**MVP = 阶段 0+1+2+3**：导入资质明细/清单 → 匹配 → 导出 + 综合查询 + 一单一库同步。
当前 **阶段 0+1+2+3 已完成，MVP 闭环**：4 类资质源齐全（省级CMA/CNAS/国家CMA 靠 Excel 导入，
一单一库自动同步），导入/同步 → 匹配 → 导出 + 综合查询全可用。省级CMA/CNAS 在线抓取（阶段 4）、
国家 CMA（阶段 5）作为后续增强。
