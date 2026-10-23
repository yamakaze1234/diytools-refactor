CREATE TABLE workbench_cloud_meta(id INTEGER PRIMARY KEY,version INTEGER NOT NULL,document TEXT NOT NULL);
CREATE TABLE workbench_cloud_rows(kind TEXT,position INTEGER,type TEXT,id TEXT,document TEXT NOT NULL,conflict INTEGER NOT NULL,PRIMARY KEY(kind,type,id));
CREATE INDEX workbench_cloud_rows_order ON workbench_cloud_rows(kind,position);
CREATE INDEX workbench_cloud_rows_conflict ON workbench_cloud_rows(conflict);
INSERT INTO workbench_cloud_meta SELECT id,version,json_remove(document,'$.records','$.materializedProjection') FROM workbench_cloud_state;
INSERT INTO workbench_cloud_rows SELECT 'records',CAST(j.key AS INTEGER),json_extract(j.value,'$.type'),json_extract(j.value,'$.id'),j.value,CASE WHEN json_type(j.value,'$.conflict')='object' THEN 1 ELSE 0 END FROM workbench_cloud_state,json_each(document,'$.records') j;
INSERT INTO workbench_cloud_rows SELECT 'materializedProjection',CAST(j.key AS INTEGER),json_extract(j.value,'$.type'),json_extract(j.value,'$.id'),j.value,CASE WHEN json_type(j.value,'$.conflict')='object' THEN 1 ELSE 0 END FROM workbench_cloud_state,json_each(document,'$.materializedProjection') j;
DROP TRIGGER IF EXISTS workbench_cloud_header_insert;
DROP TRIGGER IF EXISTS workbench_cloud_header_update;
DROP TRIGGER IF EXISTS workbench_cloud_header_delete;
DROP TABLE workbench_cloud_state;
CREATE VIEW workbench_cloud_state AS SELECT id,version,json_set(document,'$.records',json((SELECT coalesce(json_group_array(json(document)),'[]') FROM (SELECT document FROM workbench_cloud_rows WHERE kind='records' ORDER BY position))),'$.materializedProjection',json((SELECT coalesce(json_group_array(json(document)),'[]') FROM (SELECT document FROM workbench_cloud_rows WHERE kind='materializedProjection' ORDER BY position)))) document FROM workbench_cloud_meta;
CREATE TRIGGER workbench_cloud_full_insert INSTEAD OF INSERT ON workbench_cloud_state BEGIN
DELETE FROM workbench_cloud_rows WHERE kind='records';
INSERT INTO workbench_cloud_rows SELECT 'records',CAST(j.key AS INTEGER),json_extract(j.value,'$.type'),json_extract(j.value,'$.id'),j.value,CASE WHEN json_type(j.value,'$.conflict')='object' THEN 1 ELSE 0 END FROM json_each(NEW.document,'$.records') j;
DELETE FROM workbench_cloud_rows WHERE kind='materializedProjection';
INSERT INTO workbench_cloud_rows SELECT 'materializedProjection',CAST(j.key AS INTEGER),json_extract(j.value,'$.type'),json_extract(j.value,'$.id'),j.value,CASE WHEN json_type(j.value,'$.conflict')='object' THEN 1 ELSE 0 END FROM json_each(NEW.document,'$.materializedProjection') j;
INSERT OR REPLACE INTO workbench_cloud_meta VALUES(NEW.id,NEW.version,json_remove(NEW.document,'$.records','$.materializedProjection')); END;
CREATE TRIGGER workbench_cloud_meta_insert AFTER INSERT ON workbench_cloud_meta BEGIN INSERT OR REPLACE INTO workbench_cloud_header SELECT NEW.id,NEW.version,json_extract(NEW.document,'$.uid','$.workspaceId','$.cursor','$.localRevision'),json_extract(NEW.document,'$.outbox'),(SELECT count(*) FROM workbench_cloud_rows WHERE kind='records' AND conflict=1); END;
CREATE TRIGGER workbench_cloud_full_update INSTEAD OF UPDATE ON workbench_cloud_state BEGIN
DELETE FROM workbench_cloud_rows WHERE kind='records';
INSERT INTO workbench_cloud_rows SELECT 'records',CAST(j.key AS INTEGER),json_extract(j.value,'$.type'),json_extract(j.value,'$.id'),j.value,CASE WHEN json_type(j.value,'$.conflict')='object' THEN 1 ELSE 0 END FROM json_each(NEW.document,'$.records') j;
DELETE FROM workbench_cloud_rows WHERE kind='materializedProjection';
INSERT INTO workbench_cloud_rows SELECT 'materializedProjection',CAST(j.key AS INTEGER),json_extract(j.value,'$.type'),json_extract(j.value,'$.id'),j.value,CASE WHEN json_type(j.value,'$.conflict')='object' THEN 1 ELSE 0 END FROM json_each(NEW.document,'$.materializedProjection') j;
INSERT OR REPLACE INTO workbench_cloud_meta VALUES(NEW.id,NEW.version,json_remove(NEW.document,'$.records','$.materializedProjection')); END;
CREATE TRIGGER workbench_cloud_meta_update AFTER UPDATE ON workbench_cloud_meta BEGIN INSERT OR REPLACE INTO workbench_cloud_header SELECT NEW.id,NEW.version,json_extract(NEW.document,'$.uid','$.workspaceId','$.cursor','$.localRevision'),json_extract(NEW.document,'$.outbox'),(SELECT count(*) FROM workbench_cloud_rows WHERE kind='records' AND conflict=1); END;
CREATE TRIGGER workbench_cloud_full_delete INSTEAD OF DELETE ON workbench_cloud_state BEGIN DELETE FROM workbench_cloud_rows; DELETE FROM workbench_cloud_meta; DELETE FROM workbench_cloud_header; END;
