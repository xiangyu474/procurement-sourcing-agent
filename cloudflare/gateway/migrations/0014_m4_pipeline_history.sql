-- Pin the optional normalized history selected when a pipeline is reserved.
ALTER TABLE project_pipelines ADD COLUMN history_dataset_id TEXT;
ALTER TABLE project_pipelines ADD COLUMN history_r2_key TEXT;
ALTER TABLE project_pipelines ADD COLUMN history_content_sha256 TEXT;
