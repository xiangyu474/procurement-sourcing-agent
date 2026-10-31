import { useRef, useState, type MutableRefObject } from "react";
import { isAbort, isTerminalRun } from "../api/adapter";
import type { ApiClient } from "../api/client";
import type { Run, RunEvent } from "../api/types";
import { POLL_INTERVAL_MS, sleep } from "./poll";

export type RunPort = {
	run: Run | null;
	events: RunEvent[];
	stopReason: string | null;
	runRef: MutableRefObject<Run | null>;
	watch: (runId: string, signal: AbortSignal, onRun: (run: Run) => void) => Promise<void>;
	reset: () => void;
	adopt: (run: Run) => void;
};

export function useRunWatch(clientRef: MutableRefObject<ApiClient>): RunPort {
	const [run, setRun] = useState<Run | null>(null);
	const [events, setEvents] = useState<RunEvent[]>([]);
	const [stopReason, setStopReason] = useState<string | null>(null);
	const runRef = useRef(run);
	const generation = useRef(0);
	runRef.current = run;

	async function watch(runId: string, signal: AbortSignal, onRun: (run: Run) => void): Promise<void> {
		const ticket = ++generation.current;
		while (!signal.aborted && generation.current === ticket) {
			const next = await clientRef.current.getRun(runId, { signal });
			if (signal.aborted || generation.current !== ticket) return;
			runRef.current = next;
			setRun(next);
			setEvents(await clientRef.current.getRunEvents(runId, { signal }));
			onRun(next);
			if (!isTerminalRun(next.status)) {
				setStopReason(null);
				await sleep(POLL_INTERVAL_MS, signal);
				continue;
			}
			if (next.status === "PARTIAL" || next.status === "FAILED") {
				try {
					setStopReason(await clientRef.current.getStopReason(runId, { signal }));
				} catch (caught) {
					if (isAbort(caught)) return;
					setStopReason(null);
				}
			} else {
				setStopReason(null);
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
	}

	function adopt(next: Run): void {
		runRef.current = next;
		setRun(next);
	}

	return { run, events, stopReason, runRef, watch, reset, adopt };
}
