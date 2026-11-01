import { useRef, useState, type MutableRefObject } from "react";
import { isAbort, isTerminalRun } from "../api/adapter";
import type { ApiClient } from "../api/client";
import type { Run, RunEvent } from "../api/types";
import { POLL_INTERVAL_MS, sleep } from "./poll";

export type RunPort = {
	run: Run | null;
	events: RunEvent[];
	stopReason: string | null;
	candidateCount: number | null;
	runRef: MutableRefObject<Run | null>;
	watch: (runId: string, signal: AbortSignal, onRun: (run: Run) => void) => Promise<void>;
	reset: () => void;
	adopt: (run: Run) => void;
};

export function useRunWatch(clientRef: MutableRefObject<ApiClient>): RunPort {
	const [run, setRun] = useState<Run | null>(null);
	const [events, setEvents] = useState<RunEvent[]>([]);
	const [stopReason, setStopReason] = useState<string | null>(null);
	const [candidateCount, setCandidateCount] = useState<number | null>(null);
	const runRef = useRef(run);
	const generation = useRef(0);
	runRef.current = run;

	async function watch(runId: string, signal: AbortSignal, onRun: (run: Run) => void): Promise<void> {
		const ticket = ++generation.current;
		while (!signal.aborted && generation.current === ticket) {
			const [next, events] = await Promise.all([
				clientRef.current.getRun(runId, { signal }),
				clientRef.current.getRunEvents(runId, { signal }),
			]);
			if (signal.aborted || generation.current !== ticket) return;
			let reason: string | null = null;
			let count: number | null = null;
			if (next.status === "PARTIAL" || next.status === "FAILED") {
				try {
					const summary = await clientRef.current.getResearchSummary(runId, { signal });
					reason = summary.stopReason;
					count = summary.candidateCount;
				} catch (caught) {
					if (isAbort(caught) || signal.aborted || generation.current !== ticket) return;
				}
			}
			if (signal.aborted || generation.current !== ticket) return;
			runRef.current = next;
			setRun(next);
			setEvents(events);
			setStopReason(reason);
			setCandidateCount(count);
			onRun(next);
			if (!isTerminalRun(next.status)) {
				await sleep(POLL_INTERVAL_MS, signal);
				continue;
			}
			return;
		}
	}

	function reset(): void {
		generation.current += 1;
		runRef.current = null;
		setRun(null);
		setEvents([]);
		setStopReason(null);
		setCandidateCount(null);
	}

	function adopt(next: Run): void {
		runRef.current = next;
		setRun(next);
	}

	return { run, events, stopReason, candidateCount, runRef, watch, reset, adopt };
}
