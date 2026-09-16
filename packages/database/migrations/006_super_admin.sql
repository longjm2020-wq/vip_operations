INSERT INTO roles(code,name) VALUES ('SUPER_ADMIN','超级管理员') ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='SUPER_ADMIN'
ON CONFLICT DO NOTHING;
