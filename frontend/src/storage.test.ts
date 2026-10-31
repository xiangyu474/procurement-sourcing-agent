import { describe, expect, it } from "vitest";
import { blankProject, loadDraft, loadStore, saveDraft, saveStore, upsertProject } from "./storage";

describe("workspace storage", () => {
	it("round-trips the local project index and ignores corrupt data", () => {
		expect(loadStore()).toEqual({ activeProjectId: null, projects: [] });
		const project = blankProject("p1", "工业相机", false);
		project.runId = "r1";
		saveStore(upsertProject({ activeProjectId: null, projects: [] }, project));
		expect(loadStore().projects[0]).toMatchObject({ projectId: "p1", runId: "r1", title: "工业相机" });
		localStorage.setItem("psi.workspace.v1", "{");
		expect(loadStore()).toEqual({ activeProjectId: null, projects: [] });
	});

	it("keeps an unsaved draft for the current tab", () => {
		saveDraft("p1", "需要 5MP 摄像机");
		expect(loadDraft("p1")).toBe("需要 5MP 摄像机");
		saveDraft("p1", "");
		expect(loadDraft("p1")).toBe("");
	});
});
