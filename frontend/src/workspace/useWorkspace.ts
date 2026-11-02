import { useRef } from "react";
import { createApiClient, type ApiClient } from "../api/client";
import { useCandidates, type CandidateModel } from "./useCandidates";
import { useProjectSession, type ProjectSession } from "./useProjectSession";
import { useReport, type ReportModel } from "./useReport";
import { useRunWatch, type RunPort } from "./useRunWatch";

export type WorkspaceModel = ProjectSession &
	Pick<RunPort, "run" | "events" | "stopReason" | "candidateCount"> & { candidates: CandidateModel; report: ReportModel };

export function useWorkspace(client: ApiClient = createApiClient()): WorkspaceModel {
	const clientRef = useRef(client);
	clientRef.current = client;
	const runs = useRunWatch(clientRef);
	const session = useProjectSession(clientRef, runs);
	const candidates = useCandidates(clientRef, session.project?.id ?? null, runs.run, session.project?.demand_revision ?? null);
	const report = useReport(clientRef, session.project?.id ?? null, session.project?.title ?? "", runs.run, candidates.decisionsReady);
	return {
		...session,
		run: runs.run,
		events: runs.events,
		stopReason: runs.stopReason,
		candidateCount: runs.candidateCount,
		candidates,
		report,
	};
}
