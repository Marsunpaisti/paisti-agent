import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react({ babel: { plugins: ["babel-plugin-react-compiler"] } }), tailwindcss()],
	build: {
		// Output directly into the orchestrator's public/ directory so `bun start`
		// serves the UI automatically without any extra configuration.
		outDir: "../orchestrator/public/web",
		emptyOutDir: true
	},
	server: {
		proxy: {
			"/api": "http://localhost:3000",
			"/events": "http://localhost:3000"
		}
	}
});
