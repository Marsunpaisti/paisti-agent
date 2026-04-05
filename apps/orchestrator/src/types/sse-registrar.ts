export interface ISseRegistrar {
	register(sessionId: string, controller: ReadableStreamDefaultController<Uint8Array>): void;
	unregister(sessionId: string, controller: ReadableStreamDefaultController<Uint8Array>): void;
}
