CREATE TABLE color_mappings (
id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
code VARCHAR(3) NOT NULL UNIQUE CHECK(code ~ '^[0-9]{3}$' AND code <> '000' AND code <> '044'),
name VARCHAR(100) NOT NULL CHECK(length(trim(name))>0),
status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO color_mappings(code,name) VALUES ('001','黑色');
INSERT INTO color_mappings(code,name) VALUES ('002','白色');
INSERT INTO color_mappings(code,name) VALUES ('003','灰色');
INSERT INTO color_mappings(code,name) VALUES ('004','米色');
INSERT INTO color_mappings(code,name) VALUES ('005','杏色');
INSERT INTO color_mappings(code,name) VALUES ('006','卡其色');
INSERT INTO color_mappings(code,name) VALUES ('007','棕色');
INSERT INTO color_mappings(code,name) VALUES ('008','驼色');
INSERT INTO color_mappings(code,name) VALUES ('009','咖色');
INSERT INTO color_mappings(code,name) VALUES ('010','褐色');
INSERT INTO color_mappings(code,name) VALUES ('011','裸色');
INSERT INTO color_mappings(code,name) VALUES ('012','红色');
INSERT INTO color_mappings(code,name) VALUES ('013','粉红色');
INSERT INTO color_mappings(code,name) VALUES ('014','酒红色');
INSERT INTO color_mappings(code,name) VALUES ('015','橙色');
INSERT INTO color_mappings(code,name) VALUES ('016','黄色');
INSERT INTO color_mappings(code,name) VALUES ('017','绿色');
INSERT INTO color_mappings(code,name) VALUES ('018','藏青色');
INSERT INTO color_mappings(code,name) VALUES ('019','蓝色');
INSERT INTO color_mappings(code,name) VALUES ('020','紫色');
INSERT INTO color_mappings(code,name) VALUES ('021','肤色');
INSERT INTO color_mappings(code,name) VALUES ('022','金色');
INSERT INTO color_mappings(code,name) VALUES ('023','玫瑰金');
INSERT INTO color_mappings(code,name) VALUES ('024','银色');
INSERT INTO color_mappings(code,name) VALUES ('025','花色');
INSERT INTO color_mappings(code,name) VALUES ('026','彩色');
INSERT INTO color_mappings(code,name) VALUES ('027','迷彩色');
INSERT INTO color_mappings(code,name) VALUES ('028','米黄色');
INSERT INTO color_mappings(code,name) VALUES ('029','粉色');
INSERT INTO color_mappings(code,name) VALUES ('030','墨绿色');
INSERT INTO color_mappings(code,name) VALUES ('031','香槟色');
INSERT INTO color_mappings(code,name) VALUES ('032','浅绿色');
INSERT INTO color_mappings(code,name) VALUES ('033','桔色');
INSERT INTO color_mappings(code,name) VALUES ('034','米白色');
INSERT INTO color_mappings(code,name) VALUES ('035','藏蓝色');
INSERT INTO color_mappings(code,name) VALUES ('036','豆绿色');
INSERT INTO color_mappings(code,name) VALUES ('037','幻彩色');
INSERT INTO color_mappings(code,name) VALUES ('038','深黑色');
INSERT INTO color_mappings(code,name) VALUES ('039','姜黄色');
INSERT INTO color_mappings(code,name) VALUES ('040','军绿色');
INSERT INTO color_mappings(code,name) VALUES ('041','抹茶绿');
INSERT INTO color_mappings(code,name) VALUES ('042','象牙米');
INSERT INTO color_mappings(code,name) VALUES ('043','黄绿色');
INSERT INTO color_mappings(code,name) VALUES ('045','砖红色');
INSERT INTO color_mappings(code,name) VALUES ('046','深咖色');
INSERT INTO color_mappings(code,name) VALUES ('047','灰蓝色');
INSERT INTO color_mappings(code,name) VALUES ('048','桃红色');
INSERT INTO color_mappings(code,name) VALUES ('049','中灰色');
INSERT INTO color_mappings(code,name) VALUES ('050','浅灰色');
INSERT INTO color_mappings(code,name) VALUES ('051','枣红色');
INSERT INTO color_mappings(code,name) VALUES ('052','深灰色');
INSERT INTO color_mappings(code,name) VALUES ('053','浅蓝色');
INSERT INTO color_mappings(code,name) VALUES ('054','浅紫色');
INSERT INTO color_mappings(code,name) VALUES ('055','燕麦色');
INSERT INTO color_mappings(code,name) VALUES ('056','浅咖色');
INSERT INTO color_mappings(code,name) VALUES ('057','深紫色');
INSERT INTO color_mappings(code,name) VALUES ('058','紫红色');
INSERT INTO color_mappings(code,name) VALUES ('059','兰色');
INSERT INTO color_mappings(code,name) VALUES ('060','粉紫色');
INSERT INTO color_mappings(code,name) VALUES ('061','浅黄色');
INSERT INTO color_mappings(code,name) VALUES ('062','浅粉色');
INSERT INTO color_mappings(code,name) VALUES ('063','橘色');
INSERT INTO color_mappings(code,name) VALUES ('064','青色');
INSERT INTO color_mappings(code,name) VALUES ('065','奶茶色');
CREATE TABLE size_mappings (
id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
code VARCHAR(3) NOT NULL UNIQUE CHECK(code ~ '^[0-9]{3}$' AND code <> '000'),
name VARCHAR(100) NOT NULL CHECK(length(trim(name))>0),
status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO size_mappings(code,name) VALUES ('001','XS');
INSERT INTO size_mappings(code,name) VALUES ('002','S');
INSERT INTO size_mappings(code,name) VALUES ('003','M');
INSERT INTO size_mappings(code,name) VALUES ('004','L');
INSERT INTO size_mappings(code,name) VALUES ('005','XL');
INSERT INTO size_mappings(code,name) VALUES ('006','2XL');
INSERT INTO size_mappings(code,name) VALUES ('007','3XL');
INSERT INTO size_mappings(code,name) VALUES ('008','4XL');
INSERT INTO size_mappings(code,name) VALUES ('009','5XL');
INSERT INTO size_mappings(code,name) VALUES ('010','F');
