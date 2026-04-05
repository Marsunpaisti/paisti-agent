import { useQuery } from "@tanstack/react-query";
import { client } from "../api/client.js";

export function useTasks() {
	return useQuery({
		queryKey: ["tasks"],
		queryFn: () => client.getTasks(),
		refetchInterval: 3000
	});
}
