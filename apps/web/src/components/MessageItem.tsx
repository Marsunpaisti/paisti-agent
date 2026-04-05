import type { AgentMessage, AssistantPart, StoredAgentMessage } from "../api/types.js";

function AssistantParts({ parts }: { parts: AssistantPart[] }) {
	return (
		<div className="flex flex-col gap-1">
			{parts.map((p, i) => {
				if (p.type === "text")
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: assistant parts have no stable id
						<div key={i} className="bg-gray-100 rounded-lg px-4 py-3 max-w-3xl">
							<pre className="whitespace-pre-wrap text-sm font-sans">{p.text}</pre>
						</div>
					);
				if (p.type === "thinking")
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: assistant parts have no stable id
						<details key={i} className="text-xs text-gray-400 pl-1">
							<summary className="cursor-pointer">Thinking…</summary>
							<pre className="whitespace-pre-wrap mt-1 pl-2">{p.text}</pre>
						</details>
					);
				return null;
			})}
		</div>
	);
}

function renderMessage(msg: AgentMessage) {
	switch (msg.type) {
		case "assistant":
			return (
				<div className="flex flex-col gap-1">
					<AssistantParts parts={msg.parts} />
					{msg.usage && (
						<div className="text-xs text-gray-400 pl-1">
							{msg.usage.input}↑ {msg.usage.output}↓ tokens
						</div>
					)}
				</div>
			);

		case "tool_use":
			return (
				<details className="bg-blue-50 border border-blue-200 rounded px-3 py-2 text-sm">
					<summary className="cursor-pointer font-mono text-xs text-blue-700">
						{msg.toolName}
					</summary>
					<pre className="mt-2 text-xs overflow-x-auto text-gray-700">
						{JSON.stringify(msg.input, null, 2)}
					</pre>
				</details>
			);

		case "tool_result":
			return (
				<details
					className={`rounded px-3 py-2 text-sm border ${
						msg.isError ? "bg-red-50 border-red-200" : "bg-green-50 border-green-200"
					}`}
				>
					<summary className="cursor-pointer font-mono text-xs">
						{msg.toolName ?? "result"}
						{msg.isError ? " (error)" : ""}
					</summary>
					<pre className="mt-2 text-xs overflow-x-auto text-gray-700">{msg.output}</pre>
				</details>
			);

		case "result":
			return (
				<div className="bg-gray-900 text-white rounded-lg px-4 py-3 text-sm">
					<div className="font-semibold capitalize">{msg.finishReason}</div>
					{msg.summary && <p className="mt-1 text-gray-300">{msg.summary}</p>}
					<div className="mt-2 text-xs text-gray-500">
						{msg.durationMs}ms
						{msg.usage && ` · ${msg.usage.input}↑ ${msg.usage.output}↓`}
					</div>
				</div>
			);

		case "system":
			return (
				<div className="text-xs text-gray-400 py-1">
					Session {msg.sessionId} · {msg.model}
				</div>
			);

		case "user":
			return (
				<div className="flex justify-end">
					<div className="bg-black text-white rounded-lg px-4 py-3 max-w-3xl text-sm">
						{msg.content}
					</div>
				</div>
			);

		default:
			return null;
	}
}

export function MessageItem({ stored }: { stored: StoredAgentMessage }) {
	const rendered = renderMessage(stored.message);
	if (!rendered) return null;
	return <div className="py-1">{rendered}</div>;
}
