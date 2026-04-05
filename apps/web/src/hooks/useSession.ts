import { useQuery } from "@tanstack/react-query";
import { client } from "../api/client.js";

export function useTaskDetail(taskId: string) {
	return useQuery({
		queryKey: ["task", taskId],
		queryFn: () => client.getTask(taskId),
		refetchInterval: (q) =>
			q.state.data?.sessions.some((s) => s.status === "active") ? 2000 : false
	});
}

export function useSessionMessages(sessionId: string) {
	return useQuery({
		queryKey: ["session", sessionId, "messages"],
		queryFn: () => client.getSessionMessages(sessionId),
		enabled: !!sessionId
	});
}
