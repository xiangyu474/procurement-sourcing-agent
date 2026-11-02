import { useRef } from "react";
import { createApiClient, type ApiClient } from "../api/client";
import { useGuestSession } from "../session/useGuestSession";
import { useCandidates, type CandidateModel } from "./useCandidates";
import { useProjectSession, type ProjectSession } from "./useProjectSession";
import { useReport, type ReportModel } from "./useReport";
import { useRunWatch, type RunPort } from "./useRunWatch";

export type WorkspaceModel = ProjectSession &
	Pick<RunPort, "run" | "events" | "stopReason" | "candidateCount"> & {
		candidates: CandidateModel;
		report: ReportModel;
		sessionError: string | null;
	};

export function useWorkspace(client: ApiClient = createApiClient()): WorkspaceModel {
	const clientRef = useRef(client);
	clientRef.current = client;
	const session = useGuestSession(clientRef);
	const runs = useRunWatch(clientRef);
	const projectSession = useProjectSession(clientRef, runs);
	const candidates = useCandidates(clientRef, projectSession.project?.id ?? null, runs.run, projectSession.project?.demand_revision ?? null);
	const report = useReport(clientRef, projectSession.project?.id ?? null, projectSession.project?.title ?? "", runs.run, candidates.decisionsReady);
	return {
		...projectSession,
		run: runs.run,
		events: runs.events,
		stopReason: runs.stopReason,
		candidateCount: runs.candidateCount,
		candidates,
		report,
		sessionError: session.error,
	};
}
