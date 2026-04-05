import { useNavigate, useParams } from "react-router-dom";
import type { Task } from "../api/types.js";
import { useTasks } from "../hooks/useTasks.js";

const STATUS_COLORS: Record<Task["status"], string> = {
	open: "bg-gray-200 text-gray-700",
	active: "bg-blue-200 text-blue-800",
	completed: "bg-green-200 text-green-800",
	failed: "bg-red-200 text-red-800",
	stopped: "bg-yellow-200 text-yellow-800"
};

interface Props {
	onNewTask: () => void;
}

export function TaskList({ onNewTask }: Props) {
	const { data: tasks = [], isLoading } = useTasks();
	const navigate = useNavigate();
	const { id: selectedId } = useParams<{ id: string }>();

	return (
		<div className="flex flex-col h-full">
			<div className="p-3 border-b flex items-center justify-between">
				<span className="font-semibold text-sm">Tasks</span>
				<button
					type="button"
					onClick={onNewTask}
					className="text-xs bg-black text-white px-2 py-1 rounded hover:bg-gray-800"
				>
					+ New
				</button>
			</div>
			{isLoading ? (
				<div className="p-3 text-xs text-gray-400">Loading…</div>
			) : (
				<ul className="overflow-y-auto flex-1">
					{tasks.map((task) => (
						<li key={task.id}>
							<button
								type="button"
								onClick={() => navigate(`/tasks/${task.id}`)}
								className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b ${
									selectedId === task.id ? "bg-gray-100" : ""
								}`}
							>
								<div className="truncate font-medium">{task.title}</div>
								<span
									className={`inline-block text-xs px-1.5 py-0.5 rounded mt-1 ${STATUS_COLORS[task.status]}`}
								>
									{task.status}
								</span>
							</button>
						</li>
					))}
					{tasks.length === 0 && <li className="p-3 text-xs text-gray-400">No tasks yet.</li>}
				</ul>
			)}
		</div>
	);
}
