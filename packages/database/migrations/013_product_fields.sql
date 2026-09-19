CREATE TABLE product_fields (
 id text PRIMARY KEY,
 name text NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 40),
 type text NOT NULL CHECK(type IN ('text','number','date','select')),
 options jsonb NOT NULL DEFAULT '[]',
 group_name text NOT NULL DEFAULT '自定义字段',
 builtin boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE products ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}';
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000001','供应商款式编码','text','[]','基础资料',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000002','单品价','number','[]','基础资料',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000003','自定义颜色','text','[]','基础资料',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000004','标准颜色','text','[]','基础资料',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000005','尺码范围','text','[]','基础资料',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000006','上线状态（唯品会）','select','["未上架","已上架","已下架"]','唯品会',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000007','最低售卖折扣','number','[]','唯品会',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000008','选款批次','text','[]','唯品会',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000009','唯品会主标题','text','[]','唯品会',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f0000000000000000000000000000000a','吊牌限价（唯品会）','number','[]','唯品会',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f0000000000000000000000000000000b','合格证-吊牌价（唯品会）','number','[]','唯品会',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f0000000000000000000000000000000c','吊牌价白名单申请','select','["未申请","申请中","已通过","未通过"]','唯品会',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f0000000000000000000000000000000d','合格证-品名','text','[]','合格证',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f0000000000000000000000000000000e','合格证-成分含量','text','[]','合格证',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f0000000000000000000000000000000f','合格证-安全类别','text','[]','合格证',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000010','合格证-执行标准','text','[]','合格证',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000011','洗涤标志核对','select','["未核对","一致","不一致"]','质检与护理',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000012','面料材质核对','select','["未核对","一致","不一致"]','质检与护理',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000013','是否豁免','select','["是","否"]','质检与护理',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000014','衣服整改描述','text','[]','质检与护理',true);
INSERT INTO product_fields(id,name,type,options,group_name,builtin) VALUES('f00000000000000000000000000000015','检测报告编号','text','[]','质检与护理',true);
