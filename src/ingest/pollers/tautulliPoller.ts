import type { Db } from "../../db/db.js";
import type { AppConfig } from "../../config.js";
import { tautulliServerInfo } from "../../integrations/tautulliClient.js";
import { markIntegrationOk } from "../../db/repos/integrationsRepo.js";

export async function pollTautulli(db: Db, cfg: AppConfig) {
  if (!cfg.TAUTULLI_BASE_URL || !cfg.TAUTULLI_API_KEY) return;
  await tautulliServerInfo({ baseUrl: cfg.TAUTULLI_BASE_URL, apiKey: cfg.TAUTULLI_API_KEY });
  markIntegrationOk(db, "tautulli");
}
