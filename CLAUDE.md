# 给 AI / 新维护者的提示

先读 `docs/MAINTENANCE.md`（维护手册）。硬性规则：

- 金额是整数「分」；日元最小单位 100。分摊必须用 `public/settle.js`，不要另写一套。
- 修改某次游玩数据的接口一律用 `tripTx(trip, …)`（会锁住这次游玩并重新读状态），并用 `log()` 写操作记录；删除先进 `trash`。
- `schema.sql` 只追加、必须幂等；不删列。
- 改完必须 `sh tests/run.sh` 全部通过（含 `node server.js check` 全量数据校验），再 `git commit`。
- 改数据库结构前先 `sudo -u aa sh deploy/backup.sh`。
