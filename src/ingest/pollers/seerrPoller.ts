import type { Db } from "../../db/db.js";
import type { AppConfig } from "../../config.js";
import { seerrStatus } from "../../integrations/seerrClient.js";
import { markIntegrationOk } from "../../db/repos/integrationsRepo.js";

export async function pollSeerr(db: Db, cfg: AppConfig) {
  if (!cfg.SEERR_BASE_URL || !cfg.SEERR_API_KEY) return;
  await seerrStatus({ baseUrl: cfg.SEERR_BASE_URL, apiKey: cfg.SEERR_API_KEY });
  markIntegrationOk(db, "seerr");
}
