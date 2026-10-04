-- Open the three collaboration tools to existing internal roles only.
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code <> 'SUPPLIER'
  AND p.code IN ('project.read','project.create','sop.manage')
ON CONFLICT DO NOTHING;
