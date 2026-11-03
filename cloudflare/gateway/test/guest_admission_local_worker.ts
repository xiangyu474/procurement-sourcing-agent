// Test-only Worker. It is not imported by the deployed gateway.
import { reserveGuestTask, type GuestAdmissionPolicy, type GuestTaskRequest } from "../src/guest_admission";

export default {
	async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
		if (request.method !== "POST") return new Response("not found", { status: 404 });
		const body = await request.json() as { task: GuestTaskRequest; policy: GuestAdmissionPolicy };
		return Response.json(await reserveGuestTask(env.DB, body.task, body.policy));
	},
};
