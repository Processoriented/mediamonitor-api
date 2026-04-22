import { z } from "zod";

export const workItemTypeSchema = z.enum(["movie", "episode"]);
export type WorkItemType = z.infer<typeof workItemTypeSchema>;

export const stageSchema = z.enum([
  "requested",
  "searching",
  "downloading",
  "pulling",
  "importing",
  "imported",
  "plex_scanning",
  "available"
]);
export type Stage = z.infer<typeof stageSchema>;

export const healthSchema = z.enum(["ok", "stalled", "failed"]);
export type Health = z.infer<typeof healthSchema>;

export const eventSeveritySchema = z.enum(["debug", "info", "warn", "error"]);
export type EventSeverity = z.infer<typeof eventSeveritySchema>;

export const eventSchema = z.object({
  ts: z.string(),
  type: z.string(),
  source: z.string(),
  severity: eventSeveritySchema,
  message: z.string().optional(),
  data: z.unknown().optional()
});
export type WorkItemEvent = z.infer<typeof eventSchema>;

