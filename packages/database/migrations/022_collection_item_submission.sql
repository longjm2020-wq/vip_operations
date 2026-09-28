
ALTER TABLE selection_collection_items ADD COLUMN status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED'));
ALTER TABLE selection_collection_items ADD COLUMN feedback TEXT NOT NULL DEFAULT '';
UPDATE selection_collection_items i SET status=c.status,feedback=c.feedback FROM selection_collections c WHERE c.id=i.collection_id;
