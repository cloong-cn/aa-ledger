# AA 账本 维护手册

给接手维护的人看的。读完前三节就能上手。改动之前，先看「四、金额规则」和「五、数据安全机制」。

- 线上地址：本文和 `deploy/` 里的域名都写成占位的 `aa.example.com`，实际域名记在服务器的 `/srv/aa/OPS.md`（不进 git）。部署到新域名时，把 `deploy/nginx.conf` 里的 `aa.example.com` 换掉即可，程序本身不依赖域名
- 代码：`/srv/aa/app`，GitHub 公开仓库 https://github.com/cloong-cn/aa-ledger （分支 main；服务器上用 root 的 gh 登录推送），每天的备份里也有一份 git bundle
- 技术栈：Node.js 24（只依赖 `pg`）+ PostgreSQL 15 + 原生 JS 前端（无框架、无构建步骤）

---

## 一、它是干什么的

朋友出去玩，回来要 AA。管理员（或拿到邀请码的朋友）建一次「游玩」，把链接 `/t/<22 位密钥>` 发到群里。朋友打开链接、选「我是谁」就能记账，不用注册。之后系统会算出谁该转给谁多少钱，转账笔数尽量少。

功能清单见 `README.md`。

## 二、30 秒上手：最常用的命令

```sh
cd /srv/aa/app
systemctl status aa                    # 服务状态
journalctl -u aa -n 100 --no-pager     # 服务日志（报错看这里）
sh tests/run.sh                        # 全部测试：算法 + 接口 + 全量数据校验。最后应该是「失败 0 项」「全部正确」
sudo -u aa node server.js check        # 只做全量数据校验
sudo -u aa sh deploy/backup.sh         # 立即备份一次
sudo -u aa node server.js create-admin <用户名> [密码]   # 建管理员 / 忘记密码时重置
```

改完代码后的发布流程：

```sh
cd /srv/aa/app
node --check server.js && node --check public/app.js   # 语法检查
sudo -u aa sh deploy/backup.sh                          # 先备份（会改数据库结构时必做）
chown -R aa:aa /srv/aa/app && systemctl restart aa
sh tests/run.sh                                         # 必须全部通过
git add -A && git commit -m "说明改了什么"
git push                                                # 推到 GitHub
```

**回滚**：先 `git log` 找到上一个版本，再 `git checkout <版本> -- .`，然后 `systemctl restart aa`。数据库结构只加不删（见「七」），所以旧代码也能在新库上运行。

## 三、东西都在哪

| 什么 | 在哪 |
|---|---|
| 后端（全部接口、静态文件、命令行） | `server.js` |
| 数据库结构（启动时自动执行，幂等） | `schema.sql` |
| 分摊 / 结算算法（前后端共用同一份） | `public/settle.js` |
| 前端单页应用 | `public/app.js`、`public/style.css`、`public/index.html` |
| Excel 生成（无依赖） | `xlsx.js` |
| 测试 | `tests/`（`run.sh` 入口；`unit.test.js` 算法；`api.test.mjs` 接口；`cleanup.sql` 清测试数据） |
| systemd / nginx / 备份脚本样本 | `deploy/` |
| 服务 | `aa.service`，用户 `aa`，监听 `127.0.0.1:8792` |
| Nginx 配置 | `/etc/nginx/conf.d/aa.conf`（来自 `deploy/nginx.conf`，域名已换成真实的） |
| HTTPS 证书 | `/etc/letsencrypt/live/aa.example.com/`（certbot 自动续期） |
| 数据库 | 本机 PostgreSQL 15，库 `aa`，用 unix socket + peer 认证（无密码）；`pg_hba.conf` 限制 aa 角色只能连 aa 库 |
| 截图 / 收款码文件 | `/srv/aa/uploads`（文件名是随机 32 位十六进制，内容不会变） |
| 备份 | `/srv/aa/backups`（见「六」） |
| 备份定时器 | `aa-backup.timer`（每天 03:40）→ `aa-backup.service` → `deploy/backup.sh` |

`deploy/` 里的文件只是样本。改了以后要手动复制到 `/etc/systemd/system/` 或 `/etc/nginx/conf.d/`，再执行 `systemctl daemon-reload` 或 `nginx -t && systemctl reload nginx`。

## 四、金额规则（改代码前必读）

1. **金额一律存整数「分」**，不用小数，也不用浮点数存钱。`12.5 元` 存成 `1250`。
2. **币种的最小单位**：日元没有小数，最小单位是 100 分（1 円），其他币种是 1 分。规则写在 `settle.js` 的 `UNITS`。日元的金额、分摊、转账都必须是 100 的倍数。
3. **每次游玩有一个结算币种**（`trips.base_currency`，默认人民币）。`expenses.cents`、`expense_shares.cents`、`payments.cents` 都以结算币种计。
4. **外币账**的相关字段：
   - `orig_cents`：原币金额。
   - `rate`：1 单位原币折合多少结算币种。
   - `cents = 按最小单位取整(orig_cents × rate)`。
   - 填了「实付金额」（刷卡账单）的账 `cny_override = true`，`cents` 用实付金额，不按汇率算。
   - 同一次游玩里，同一个币种只用一个汇率，存在 `trip_rates`。改汇率会重算这个币种所有没有填实付金额的账。
5. **分摊**（`splitExpense`）：
   - 先按原币分：指定金额的人先扣掉，剩下的按份数分。
   - 再把结算币种总额按各人的原币份额比例分。
   - 除不尽的零头按「最大余数法」补；余数相同时补给 memberId 小的人。
   - **结果和录入顺序无关**。数据校验靠这一点：任何时候用存下来的份数和指定金额重算，都必须得到一模一样的结果。
   - 每笔账的各人分摊，加起来**正好等于**总额，一分不差。
6. **结算**：
   - 每人净额 = 垫付 − 应摊 + 已转出 − 已收到。所有人净额加起来恒等于 0。
   - 欠得最多的人转给被欠得最多的人，反复配对，转账笔数最多是人数 − 1。
7. 有转账记录后不能再换结算币种，以免已转金额换算出零头。

**动算法时**：同步修改 `tests/unit.test.js`，里面有 2 万多组随机对拍，检查上面这些不变量。

## 五、数据安全机制

### 5.1 防止算错（四道关）

| 层 | 做什么 | 在哪 |
|---|---|---|
| 算法 + 测试 | 固定用例和 2 万多组随机用例，检查总和相等、不出负数、整円、与顺序无关、同份数的人差额不超过 1 个单位、按建议转账后全部清零 | `tests/unit.test.js` |
| 并发排队 | 改某次游玩的数据前先 `SELECT … FOR UPDATE` 锁住这次游玩那一行，同一次游玩的修改按顺序执行。两个人同时改汇率和记账，也不会出现半新半旧的数据 | `server.js` 的 `tripTx()`。**新增修改类接口一律用 `tripTx`，不要直接用 `tx`** |
| 数据库触发器 | 事务提交时检查以下各项，不满足就整笔回滚，即使代码有 bug，不平的账也存不进去：每笔账至少一人分摊；各人分摊（结算币种和原币）加起来等于总额；没有负数；付款人和分摊人都是本次游玩成员；转账双方是本次游玩成员且不是同一人 | `schema.sql` 末尾的 `aa_check_expense` / `aa_check_payment`。触发时前端提示「数据校验没通过，这次修改没有保存」，日志里有 `aa_invariant` |
| 全量校验 | 把所有账按存下的份数和汇率重算，逐分比对；检查每次游玩净额之和为 0、建议转账总额等于未结清金额、图片文件都在磁盘上 | `server.js` 的 `verifyData()`。每天备份后自动跑一次；管理员首页顶部显示结果；也可以手动运行 `node server.js check` |

### 5.2 防止丢数据

- **回收站**：
  - 删除账目或截图时，先把完整快照存进 `trash` 表，图片文件不删。成员页「最近删除」里可以恢复。
  - 删除游玩只是标记 `trips.deleted_at`，在管理员菜单「回收站」里可以恢复。
  - 保存 30 天（`TRASH_DAYS`）后，由 `purgeTrash()`（每小时跑一次）真正删除。
  - 恢复账目时，会按**当前**的汇率和结算币种重新计算。
- **操作记录**：所有改动都写进 `audit` 表，包括谁、什么时候、改了什么。在成员页「操作记录」里查看。
- **锁定**：结清后锁定账单，只有管理员能解锁。
- **每日备份**：见「六」。
- **PostgreSQL** 保持默认的 `fsync=on`、`full_page_writes=on`。断电时已提交的数据不会丢。不要改这两个设置。

## 六、备份与恢复

### 6.1 备份了什么

`deploy/backup.sh` 每天 03:40 运行一次。每一步都先写临时文件，校验完整后才改成正式文件名；任何一步失败，`systemctl status aa-backup` 就会显示 failed。

| 文件 | 内容 | 保留 |
|---|---|---|
| `aa-YYYYMMDD-HHMM.sql.gz` | 整个数据库（pg_dump） | 60 天；最新 7 份永远保留 |
| `uploads/` | 截图和收款码的增量镜像 | 服务器上删掉的图片，在这里再留 90 天 |
| `code-YYYYMMDD.bundle` | 代码仓库完整历史（GitHub 上也有） | 30 天 |

备份结束后还会跑一次 `node server.js check`。检查结果会写进 `journalctl -u aa-backup` 的日志。

**⚠️ 备份和数据在同一台服务器上**，硬盘坏了或者服务器被删就会一起丢。目前的补救办法是管理员定期在「⋯ → 数据安全 → 下载最新数据库备份」下载一份，存到自己的电脑或网盘。如果以后有另一台机器或对象存储，可以在 `backup.sh` 末尾加一行 `rsync` 或 `rclone`，把整个 `/srv/aa/backups` 同步过去。

### 6.2 恢复整个数据库

```sh
systemctl stop aa
sudo -u aa sh /srv/aa/app/deploy/backup.sh || true      # 先把现在的状态也备份一份，万一要反悔
sudo -u postgres dropdb aa && sudo -u postgres createdb -O aa aa
zcat /srv/aa/backups/aa-YYYYMMDD-HHMM.sql.gz | sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d aa
cp -n /srv/aa/backups/uploads/* /srv/aa/uploads/ 2>/dev/null; chown -R aa:aa /srv/aa/uploads
systemctl start aa
sudo -u aa node /srv/aa/app/server.js check               # 校验
```

### 6.3 只找回某一笔或某一次游玩

先看 30 天内的回收站，能在那里恢复就不用动备份。超过 30 天的，把备份恢复到一个临时库里，查到数据后再手动补回：

```sh
sudo -u postgres createdb aa_old
zcat /srv/aa/backups/aa-YYYYMMDD-HHMM.sql.gz | sudo -u postgres psql -q -d aa_old
sudo -u postgres psql -d aa_old      # 查到需要的数据
sudo -u postgres dropdb aa_old       # 用完删掉
```

### 6.4 恢复代码

```sh
git clone /srv/aa/backups/code-YYYYMMDD.bundle /srv/aa/app-restored
```

### 6.5 搬到新服务器

1. 装好 Node 24、PostgreSQL 15、nginx 和 certbot。
2. `useradd -r -d /srv/aa aa`，然后 `git clone https://github.com/cloong-cn/aa-ledger /srv/aa/app`（或从 bundle 克隆），在里面运行 `npm ci`。
3. `createuser aa && createdb -O aa aa`，然后按 6.2 导入数据库并复制图片。
4. 复制 `deploy/` 里的 service、timer 和 nginx 配置，再申请证书：`certbot --nginx -d aa.example.com`。
5. 启用服务和定时器：`systemctl enable --now aa aa-backup.timer`。

### 6.6 恢复演练

建议每季度做一次。把最新备份恢复到临时库 `aa_restore_test`，对比各表行数是否和线上一致，然后删掉临时库。2026-11-25 做过一次，结果一致，触发器也一起恢复了。

## 七、改动指南

- **改数据库结构**：
  - 只往 `schema.sql` 末尾追加，并且必须幂等，例如 `CREATE TABLE IF NOT EXISTS`、`ALTER TABLE … ADD COLUMN IF NOT EXISTS`，因为每次启动都会整份执行。
  - 不删列、不改列含义；确实要改，就新加一列并迁移数据。
  - 改之前先备份。
- **新增修改数据的接口**：
  - 用 `tripTx(trip, async (q) => …)`；
  - 用 `log()` 写操作记录；
  - 删除的东西先放进 `trash`；
  - 在 `tests/api.test.mjs` 加用例。
- **加币种**：
  - 改 `server.js` 的 `CURRENCIES` 和 `public/app.js` 的 `CURS`；
  - 如果新币种没有小数，在 `settle.js` 的 `UNITS` 里登记最小单位；
  - 汇率接口 open.er-api.com 支持几乎所有币种。
- **加消费类别**：改 `server.js` 的 `CATEGORIES` 和 `public/app.js` 的 `CATS`。
- **改分摊或结算规则**：
  - 先读「四」；
  - 同时修改 `settle.js` 和 `verifyData()`，确保重算逻辑一致；
  - 跑 `sh tests/run.sh`；
  - 发布后再跑一次 `node server.js check`，确认历史数据还能通过校验。
- **前端**：
  - 没有构建步骤，改完刷新浏览器即可；
  - 手机端的 Safari 和微信内置浏览器都要试一下。

## 八、出问题怎么办

| 现象 | 处理 |
|---|---|
| 网站打不开 | 依次运行 `systemctl status aa`、`journalctl -u aa -n 100`、`nginx -t`、`systemctl status postgresql` |
| 管理员首页顶部变红「校验发现问题」 | 先**别改数据**。点开查看具体哪次游玩、哪笔账有问题，再看这次游玩的「操作记录」找到是谁、什么时候改的。<br>分摊不平或汇率不一致，可以在页面上把这笔账打开，原样「修改」保存一次，系统会重新计算。<br>图片文件丢失，就从 `/srv/aa/backups/uploads/` 复制回来。<br>处理完再跑 `node server.js check` |
| 顶部显示「最近备份 N 天前」 | 依次运行 `systemctl status aa-backup`、`journalctl -u aa-backup -n 50`、`systemctl list-timers aa-backup.timer`。常见原因是磁盘满，用 `df -h` 检查 |
| 用户反馈「数据校验没通过，这次修改没有保存」 | 说明代码有 bug，被数据库触发器拦下了，数据没有坏。用 `journalctl -u aa` 搜 `aa_invariant`，找到具体是哪笔，然后复现并修复 |
| 外币记账提示拿不到汇率 | open.er-api.com 暂时不可用。让用户手动填汇率即可。缓存在 `fx_cache` 表 |
| 分享链接泄露 | 管理员在这次游玩的成员页点「重置分享链接」，旧链接会立即失效 |
| 忘记管理员密码 | `sudo -u aa node server.js create-admin <用户名> <新密码>` |
| 证书过期 | `certbot renew`，然后检查 `systemctl list-timers \| grep certbot` |
| 磁盘快满 | 先 `du -sh /srv/aa/uploads /srv/aa/backups`。不要手动删最新的备份，可以缩短 `backup.sh` 里的保留天数 |

## 九、安全设计（不要无意中破坏）

- **仓库是公开的**：不要提交真实域名、服务器 IP、密码、`.env`、数据库导出、截图或任何真实账目数据（测试只用 zz 开头的假数据）。提交前可以跑 `git grep -nE '<真实域名>|<服务器IP>'` 检查一遍。

- **分享链接 = 这次游玩的全部权限**。密钥是 128 位随机数。nginx 设了 `Referrer-Policy: same-origin`，避免链接通过 Referer 泄露，不要去掉。
- **CSRF 防护**：修改类接口只接受 `application/json`，上传图片只接受 `image/*`，并且会检查文件头。新增接口时也要遵守。
- **登录和邀请码**都有错误次数限制：nginx 的 `aa_login` 限速，加上 `login_fails` 表。
- **管理员会话**：数据库里只存 token 的 SHA-256；密码用 scrypt 加盐哈希。
- **服务权限**：systemd 让服务只能写 `/srv/aa/uploads`，代码目录对服务只读。
- **备份**里含管理员密码哈希。下载下来的备份文件不要公开。

## 十、每月检查清单

- [ ] 管理员首页顶部是绿色（校验通过，最近备份在 1 天内）
- [ ] 下载一份数据库备份，存到服务器以外的地方
- [ ] `df -h /`：磁盘使用低于 80%
- [ ] `apt list --upgradable 2>/dev/null | grep -E 'nodejs|postgresql|nginx'`：有安全更新就升级，升级后跑 `sh tests/run.sh`
- [ ] 每季度做一次恢复演练（见 6.6）
