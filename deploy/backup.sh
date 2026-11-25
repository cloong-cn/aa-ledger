#!/bin/sh
# AA 账本每日备份。由 aa-backup.timer 每天 03:40 以 aa 用户执行；也可以随时手动跑：
#   sudo -u aa sh /srv/aa/app/deploy/backup.sh
# 产物（都在 $BACKUPS，默认 /srv/aa/backups）：
#   aa-YYYYMMDD-HHMM.sql.gz       数据库完整导出，保留 60 天（每个文件都校验过完整才保留）
#   uploads/                      截图和收款码的镜像：只增不改（文件名唯一、内容不变）；
#                                 服务器上删掉的图片在这里再留 90 天，所以 60 天内任一份数据库备份恢复后图片都齐
#   code-YYYYMMDD.bundle          代码仓库（git bundle，含全部历史），保留 30 天
# 任何一步失败脚本就以非 0 退出，systemctl status aa-backup 能看到；半成品文件不会留下。
set -eu
B=${BACKUPS:-/srv/aa/backups}
UP=${UPLOADS:-/srv/aa/uploads}
APP=$(cd "$(dirname "$0")/.." && pwd)
d=$(date +%Y%m%d-%H%M)
cd "$B"
trap 'rm -f "$B"/.tmp-* "$B"/uploads/.tmp-*' EXIT

# 1. 数据库：先写临时文件，确认 gzip 完整、导出写到了结尾，再改成正式文件名
pg_dump -d aa | gzip > ".tmp-db"
gzip -t ".tmp-db"
zcat ".tmp-db" | tail -n 20 | grep -q 'PostgreSQL database dump complete'
mv ".tmp-db" "aa-$d.sql.gz"

# 2. 图片：增量镜像（已有的不再复制）
mkdir -p uploads
for f in "$UP"/*; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  if [ ! -e "uploads/$n" ]; then cp "$f" "uploads/.tmp-$n"; mv "uploads/.tmp-$n" "uploads/$n"; fi
done
# 服务器上已经没有的图片：第一次发现时记一个 .gone-<文件名> 标记，标记满 90 天才删除镜像里的文件
for f in uploads/*; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  if [ -e "$UP/$n" ]; then rm -f "uploads/.gone-$n"
  elif [ ! -e "uploads/.gone-$n" ]; then touch "uploads/.gone-$n"
  elif [ -n "$(find "uploads/.gone-$n" -mtime +90)" ]; then rm -f "$f" "uploads/.gone-$n"; fi
done

# 3. 代码（本地仓库没有远程，备份一份完整历史）
git -C "$APP" bundle create "$B/.tmp-code" --all 2>/dev/null
git -C "$APP" bundle verify "$B/.tmp-code" >/dev/null 2>&1
mv ".tmp-code" "code-$(date +%Y%m%d).bundle"

# 4. 清理过期备份（只删旧的；最新的 7 份数据库备份无论多旧都保留）
ls -1 aa-*.sql.gz | sort -r | tail -n +8 | while read -r f; do find "$f" -mtime +60 -delete; done
find . -maxdepth 1 -name 'code-*.bundle' -mtime +30 -delete
find . -maxdepth 1 -name 'uploads-*.tar.gz' -mtime +14 -delete   # 旧版打包方式留下的

# 5. 顺手做一次全量数据校验（结果写进日志；有问题时备份照样保留，但本次任务标记为失败）
node "$APP/server.js" check
