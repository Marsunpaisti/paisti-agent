import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { client } from "../api/client.js";

interface Props {
	onClose: () => void;
}

export function NewTaskForm({ onClose }: Props) {
	const [title, setTitle] = useState("");
	const [message, setMessage] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!title.trim() || !message.trim()) return;
		setSubmitting(true);
		setError(null);
		try {
			const taskId = await client.submitTask({
				type: "task_assigned",
				taskRef: { platform: "cli", id: crypto.randomUUID() },
				title: title.trim(),
				initialMessage: message.trim()
			});
			await queryClient.invalidateQueries({ queryKey: ["tasks"] });
			navigate(`/tasks/${taskId}`);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Submission failed");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss is standard UX
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled at the modal level by the browser
		<div
			className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
			onClick={(e) => e.target === e.currentTarget && onClose()}
		>
			<div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg mx-4">
				<h2 className="font-semibold text-lg mb-4">New Task</h2>
				<form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
					<div>
						<label htmlFor="task-title" className="block text-sm font-medium mb-1">
							Title
						</label>
						<input
							id="task-title"
							className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="Fix the auth bug"
						/>
					</div>
					<div>
						<label htmlFor="task-message" className="block text-sm font-medium mb-1">
							Initial message
						</label>
						<textarea
							id="task-message"
							className="w-full border rounded px-3 py-2 text-sm h-28 resize-none focus:outline-none focus:ring-2 focus:ring-black"
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							placeholder="Describe what the agent should do…"
						/>
					</div>
					{error && <p className="text-sm text-red-600">{error}</p>}
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={onClose}
							className="px-4 py-2 text-sm rounded border hover:bg-gray-50"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={submitting || !title.trim() || !message.trim()}
							className="px-4 py-2 text-sm rounded bg-black text-white hover:bg-gray-800 disabled:opacity-50"
						>
							{submitting ? "Submitting…" : "Create"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
