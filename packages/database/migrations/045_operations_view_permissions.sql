-- Add only the requested read permissions to the existing operations roles.
-- store_operation is the configured shop operations role; OPERATOR is product operations.
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code IN ('store_operation','OPERATOR')
  AND p.code IN ('selection.read','inventory.read')
ON CONFLICT DO NOTHING;
