-- Progress of a running pipeline, so a visitor sees what has been found
-- before the assessment and the decision are finished.
ALTER TABLE project_pipelines ADD COLUMN candidates_found INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_pipelines ADD COLUMN models_found INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_pipelines ADD COLUMN evidence_found INTEGER NOT NULL DEFAULT 0;
