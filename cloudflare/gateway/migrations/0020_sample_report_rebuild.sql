-- A sample report that was copied from another run carries that run's document,
-- even though the row names the sample's version. The row is removed so the
-- sample gets a report written for the sample itself.
UPDATE project_pipelines
SET report_id = NULL, report_status = 'NOT_STARTED', report_error_code = NULL
WHERE report_id IN (
    SELECT id FROM project_reports WHERE workflow_id LIKE 'sample\_%' ESCAPE '\'
);

DELETE FROM project_reports WHERE workflow_id LIKE 'sample\_%' ESCAPE '\';
