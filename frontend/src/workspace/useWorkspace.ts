import { useRef } from "react";
import { createApiClient, type ApiClient } from "../api/client";
import { useProjectSession, type ProjectSession } from "./useProjectSession";
import { useRunWatch, type RunPort } from "./useRunWatch";

export type WorkspaceModel = ProjectSession & Pick<RunPort, "run" | "events" | "stopReason" | "candidateCount">;

export function useWorkspace(client: ApiClient = createApiClient()): WorkspaceModel {
	const clientRef = useRef(client);
	clientRef.current = client;
	const runs = useRunWatch(clientRef);
	const session = useProjectSession(clientRef, runs);
	return {
		...session,
		run: runs.run,
		events: runs.events,
		stopReason: runs.stopReason,
		candidateCount: runs.candidateCount,
	};
}
