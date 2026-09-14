INSERT INTO permissions(code,name) VALUES('project.read','项目协作'),('project.create','创建项目'),('sop.manage','维护岗位SOP') ON CONFLICT DO NOTHING;
INSERT INTO roles(code,name) VALUES('PRODUCT','商品'),('CUSTOMER','客服'),('FINANCE','财务') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE p.code IN ('project.read','project.create','sop.manage') ON CONFLICT DO NOTHING;
CREATE TABLE project_sops (
 id BIGSERIAL PRIMARY KEY, owner_id BIGINT REFERENCES users(id), name TEXT NOT NULL,
 department TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', steps JSONB NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO project_sops(name,department,description,steps) VALUES('商品周上新','运营','从上新计划到库存售卖，七个环节协作交付。',
'[{"id":"plan","name":"上新计划制定","description":"制定周上新计划，明确产品需求、接收人与交付时间。"},{"id":"source","name":"买手找品","description":"按上新计划需求找品，把产品安排到公司。"},{"id":"select","name":"到样选款","description":"买手、运营一起选款，确定可上新款式。"},{"id":"catalog","name":"商品建档","description":"待补充：可按本次项目添加任务与交付要求。"},{"id":"photo","name":"拍摄修图","description":"待补充：可按本次项目添加任务与交付要求。"},{"id":"link","name":"做商品链接","description":"待补充：可按本次项目添加任务与交付要求。"},{"id":"stock","name":"同步库存售卖","description":"待补充：可按本次项目添加任务与交付要求。"}]');
CREATE TABLE projects (
 id BIGSERIAL PRIMARY KEY,owner_id BIGINT NOT NULL REFERENCES users(id),name TEXT NOT NULL DEFAULT '',tag TEXT NOT NULL DEFAULT '周上新',
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','ACTIVE','DONE','VOID')),
 document JSONB NOT NULL DEFAULT '{}',version INTEGER NOT NULL DEFAULT 1,
 published_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE project_members(project_id BIGINT REFERENCES projects(id),user_id BIGINT REFERENCES users(id),added_by BIGINT NOT NULL REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(project_id,user_id));
CREATE INDEX project_member_user ON project_members(user_id,project_id);
CREATE TABLE project_messages(id BIGSERIAL PRIMARY KEY,project_id BIGINT NOT NULL REFERENCES projects(id),sender_id BIGINT NOT NULL REFERENCES users(id),body TEXT NOT NULL,task_ids JSONB NOT NULL DEFAULT '[]',mentions JSONB NOT NULL DEFAULT '[]',created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX project_message_page ON project_messages(project_id,id DESC);
CREATE TABLE project_notifications(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id),project_id BIGINT NOT NULL REFERENCES projects(id),body TEXT NOT NULL,read_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX project_notification_user ON project_notifications(user_id,id DESC);
