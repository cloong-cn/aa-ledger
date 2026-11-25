#!/bin/sh
# 对本机服务跑一遍接口测试，用临时数据 zz*，跑完自动清理。用法：sh tests/run.sh
cd "$(dirname "$0")/.."
sudo -u aa psql -q -d aa -f tests/cleanup.sql >/dev/null 2>&1
sudo -u aa node server.js create-admin zzadmin test-admin-1 >/dev/null
node tests/unit.test.js; u=$?
node tests/api.test.mjs; rc=$?
sudo -u aa psql -q -d aa -f tests/cleanup.sql >/dev/null 2>&1
sudo -u aa UPLOADS=/srv/aa/uploads node server.js clean-uploads >/dev/null
exit $((u + rc))
