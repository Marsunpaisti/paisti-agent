import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { Session } from "../api/types.js";
import { useSessionMessages } from "../hooks/useSession.js";
import { useSessionStream } from "../hooks/useSessionStream.js";
import { MessageItem } from "./MessageItem.js";

interface Props {
	session: Session;
}

export function ChatView({ session }: Props) {
	const queryClient = useQueryClient();
	const { data: stored = [] } = useSessionMessages(session.id);
	const bottomRef = useRef<HTMLDivElement>(null);

	// Stream live messages — only when session is active
	useSessionStream(session.status === "active" ? session.id : null, () => {
		void queryClient.invalidateQueries({ queryKey: ["session", session.id, "messages"] });
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new messages arrive
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [stored]);

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{session.systemPrompt && (
				<details className="border-b bg-yellow-50 px-4 py-2 text-xs">
					<summary className="cursor-pointer font-semibold text-yellow-800">System prompt</summary>
					<pre className="mt-2 whitespace-pre-wrap text-gray-700">{session.systemPrompt}</pre>
				</details>
			)}
			<div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-2">
				{stored.map((s) => (
					<MessageItem key={s.sequence} stored={s} />
				))}
				<div ref={bottomRef} />
			</div>
		</div>
	);
}
