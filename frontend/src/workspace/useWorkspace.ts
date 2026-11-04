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
		sessionReady: boolean;
		sessionMode: "guest" | "operator" | "unknown";
	};

export function useWorkspace(client: ApiClient = createApiClient()): WorkspaceModel {
	const clientRef = useRef(client);
	clientRef.current = client;
	const session = useGuestSession(clientRef);
	const runs = useRunWatch(clientRef);
	const projectSession = useProjectSession(clientRef, runs, session.ready);
	const project = projectSession.project;
	const run = runs.run && runs.run.project_id === project?.id ? runs.run : null;
	const candidates = useCandidates(
		clientRef,
		project?.id ?? null,
		run?.id ?? null,
		run?.status ?? null,
		projectSession.pipelineActive,
	);
	const report = useReport(
		clientRef,
		project?.id ?? null,
		project?.title ?? "",
		run,
		candidates.decisionsReady,
		candidates.analysisReport,
		candidates.analysisPipelineId,
		session.mode !== "guest",
	);
	return {
		...projectSession,
		run: runs.run,
		events: runs.events,
		stopReason: runs.stopReason,
		candidateCount: runs.candidateCount,
		candidates,
		report,
		sessionError: session.error,
		sessionReady: session.ready,
		sessionMode: session.mode,
	};
}
