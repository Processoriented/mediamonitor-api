import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default("0.0.0.0"),

  DATA_DIR: z.string().default("./data"),
  SQLITE_FILE: z.string().default("mediamonitor.sqlite"),

  LOG_LEVEL: z.string().default("info"),

  // Integrations (placeholders; add as we implement clients)
  SEERR_BASE_URL: z.string().optional(),
  SEERR_API_KEY: z.string().optional(),

  SONARR_BASE_URL: z.string().optional(),
  SONARR_API_KEY: z.string().optional(),

  RADARR_BASE_URL: z.string().optional(),
  RADARR_API_KEY: z.string().optional(),

  SABNZBD_BASE_URL: z.string().optional(),
  SABNZBD_API_KEY: z.string().optional(),

  TAUTULLI_BASE_URL: z.string().optional(),
  TAUTULLI_API_KEY: z.string().optional()
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}

export function sqlitePath(cfg: AppConfig): string {
  const dir = cfg.DATA_DIR.replace(/\/+$/, "");
  return `${dir}/${cfg.SQLITE_FILE}`;
}

