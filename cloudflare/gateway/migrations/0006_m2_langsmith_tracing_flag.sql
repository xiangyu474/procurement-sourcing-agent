-- M2 follow-up: record whether the run had an enabled LangSmith exporter.
-- Additive only; existing run-cost rows default to disabled.
ALTER TABLE research_run_costs
    ADD COLUMN langsmith_tracing_enabled INTEGER NOT NULL DEFAULT 0;
