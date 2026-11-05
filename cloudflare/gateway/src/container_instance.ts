// One container instance per pipeline.
//
// The research is the heaviest part of a run: it holds page snapshots, model
// contexts and the parallel researchers in one process. Two runs that share
// an instance fight over the same memory, and the loser does not fail with a
// clear reason but takes the whole instance down. Giving every pipeline its
// own instance keeps one visitor's run from killing another's.

const MAX_NAME_LENGTH = 63;

/** The instance name a pipeline uses, derived from its own id. */
export function pipelineInstanceName(base: string, pipelineId: string | null | undefined): string {
	const prefix = base.replace(/[^a-z0-9-]/gi, "-").slice(0, 24);
	if (!pipelineId) return prefix;
	const suffix = pipelineId.replace(/[^a-z0-9]/gi, "").slice(0, 16).toLowerCase();
	if (!suffix) return prefix;
	return `${prefix}-${suffix}`.slice(0, MAX_NAME_LENGTH);
}
