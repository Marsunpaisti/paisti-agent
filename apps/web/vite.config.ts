import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	build: {
		// Output directly into the orchestrator's public/ directory so `bun start`
		// serves the UI automatically without any extra configuration.
		outDir: "../orchestrator/public",
		emptyOutDir: true
	},
	server: {
		proxy: {
			"/api": "http://localhost:3000",
			"/events": "http://localhost:3000"
		}
	}
});
