import { arrSystemStatus } from "./arrClient.js";

export async function arrPing(args: { baseUrl: string; apiKey: string }): Promise<void> {
  await arrSystemStatus(args);
}

