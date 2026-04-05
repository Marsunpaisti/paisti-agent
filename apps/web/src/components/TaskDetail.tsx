import { useState } from "react";
import { useParams } from "react-router-dom";
import type { Session } from "../api/types.js";
import { useTaskDetail } from "../hooks/useSession.js";
import { ChatView } from "./ChatView.js";

const STATUS_DOT: Record<Session["status"], string> = {
	active: "bg-blue-500 animate-pulse",
	completed: "bg-green-500",
	failed: "bg-red-500",
	stopped: "bg-yellow-500"
};

export function TaskDetail() {
	const { id } = useParams<{ id: string }>();
	const { data, isLoading } = useTaskDetail(id!);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

	if (isLoading) return <div className="p-4 text-sm text-gray-400">Loading…</div>;
	if (!data) return <div className="p-4 text-sm text-red-500">Task not found.</div>;

	const { task, sessions } = data;
	const activeSession = sessions.find((s) => s.status === "active");
	const currentSession: Session | undefined =
		sessions.find((s) => s.id === selectedSessionId) ??
		activeSession ??
		sessions[sessions.length - 1];

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="border-b px-4 py-3 flex-shrink-0">
				<div className="font-semibold truncate">{task.title}</div>
				{/* Session tabs */}
				{sessions.length > 0 && (
					<div className="flex gap-2 mt-2 overflow-x-auto">
						{sessions.map((s, i) => (
							<button
								key={s.id}
								type="button"
								onClick={() => setSelectedSessionId(s.id)}
								className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded border flex-shrink-0 ${
									currentSession?.id === s.id
										? "bg-black text-white border-black"
										: "border-gray-300 hover:bg-gray-50"
								}`}
							>
								<span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[s.status]}`} />
								Session {i + 1}
							</button>
						))}
					</div>
				)}
			</div>
			{/* Chat */}
			{currentSession ? (
				<div className="flex-1 overflow-hidden">
					<ChatView session={currentSession} />
				</div>
			) : (
				<div className="flex items-center justify-center flex-1 text-sm text-gray-400">
					No sessions yet
				</div>
			)}
		</div>
	);
}
