# qual-match 项目约定

## 工程操作规则（强制）

- **增量读写，不要一次性读入或写入太多内容**。大块读写容易触发 `Stream error: error decoding response body`。
  - 写文件：分节、增量写入（先 Write 骨架，再逐节 Edit 追加）。
  - 读文件：超大文件用 offset/limit 分段读，不要整文件一次拉。

## 项目背景

详见 `docs/DESIGN.md`（单一真相源，6 节）与 `docs/HANDOFF.md`（当前进度 + 续接指南）。
