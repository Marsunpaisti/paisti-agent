import { useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { TaskDetail } from "./components/TaskDetail.js";
import { TaskList } from "./components/TaskList.js";

export function App() {
	const [showNewTask, setShowNewTask] = useState(false);
	void showNewTask;

	return (
		<BrowserRouter>
			<div className="flex h-screen bg-white text-gray-900 font-sans">
				<aside className="w-64 border-r flex-shrink-0 flex flex-col">
					<TaskList onNewTask={() => setShowNewTask(true)} />
				</aside>
				<main className="flex-1 overflow-hidden">
					<Routes>
						<Route path="/tasks/:id" element={<TaskDetail />} />
						<Route
							path="/"
							element={
								<div className="flex items-center justify-center h-full text-sm text-gray-400">
									Select a task or create a new one
								</div>
							}
						/>
						<Route path="*" element={<Navigate to="/" replace />} />
					</Routes>
				</main>
			</div>
		</BrowserRouter>
	);
}
