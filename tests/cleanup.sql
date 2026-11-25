-- 清理测试数据（zz 开头的管理员 / 游玩 / 人）
DELETE FROM expense_shares WHERE expense_id IN (SELECT e.id FROM expenses e JOIN trips t ON t.id=e.trip_id WHERE t.name LIKE 'zz%');
DELETE FROM expenses WHERE trip_id IN (SELECT id FROM trips WHERE name LIKE 'zz%');
DELETE FROM payments WHERE trip_id IN (SELECT id FROM trips WHERE name LIKE 'zz%');
DELETE FROM trips WHERE name LIKE 'zz%';
DELETE FROM people WHERE name LIKE 'zz%' AND id NOT IN (SELECT person_id FROM members);
DELETE FROM admins WHERE username LIKE 'zz%';
DELETE FROM invites WHERE note LIKE 'zz%';
