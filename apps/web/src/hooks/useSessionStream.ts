import { useEffect, useRef } from "react";

export function useSessionStream(sessionId: string | null, onMessage: () => void): void {
	const onMessageRef = useRef(onMessage);
	useEffect(() => {
		onMessageRef.current = onMessage;
	});

	useEffect(() => {
		if (!sessionId) return;

		const es = new EventSource(`/api/sessions/${sessionId}/stream`);

		es.onmessage = () => {
			onMessageRef.current();
		};

		es.addEventListener("close", () => {
			es.close();
			onMessageRef.current(); // final invalidation after session closes
		});

		es.onerror = () => {
			es.close();
		};

		return () => {
			es.close();
		};
	}, [sessionId]); // intentionally excludes onMessage — stabilised via ref
}
