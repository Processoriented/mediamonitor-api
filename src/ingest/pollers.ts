import type { Db } from "../db/db.js";
import { loadConfig } from "../config.js";
import { markIntegrationError, markIntegrationOk } from "../db/repos/integrationsRepo.js";
import { arrPing } from "../integrations/arr.js";

export type Poller = {
  name: string;
  runOnce: () => Promise<void>;
};

export function createPollers(db: Db): Poller[] {
  const cfg = loadConfig();

  const pollers: Poller[] = [];

  // Stubs for now: we mark integrations as OK if configured,
  // otherwise we leave them absent. Next iteration will fetch real data.
  pollers.push({
    name: "seerr",
    runOnce: async () => {
      if (!cfg.SEERR_BASE_URL || !cfg.SEERR_API_KEY) return;
      markIntegrationOk(db, "seerr");
    }
  });
  pollers.push({
    name: "sonarr",
    runOnce: async () => {
      if (!cfg.SONARR_BASE_URL || !cfg.SONARR_API_KEY) return;
      await arrPing({ baseUrl: cfg.SONARR_BASE_URL, apiKey: cfg.SONARR_API_KEY });
      markIntegrationOk(db, "sonarr");
    }
  });
  pollers.push({
    name: "radarr",
    runOnce: async () => {
      if (!cfg.RADARR_BASE_URL || !cfg.RADARR_API_KEY) return;
      await arrPing({ baseUrl: cfg.RADARR_BASE_URL, apiKey: cfg.RADARR_API_KEY });
      markIntegrationOk(db, "radarr");
    }
  });
  pollers.push({
    name: "sabnzbd",
    runOnce: async () => {
      if (!cfg.SABNZBD_BASE_URL || !cfg.SABNZBD_API_KEY) return;
      markIntegrationOk(db, "sabnzbd");
    }
  });
  pollers.push({
    name: "tautulli",
    runOnce: async () => {
      if (!cfg.TAUTULLI_BASE_URL || !cfg.TAUTULLI_API_KEY) return;
      markIntegrationOk(db, "tautulli");
    }
  });

  // Wrap each poller to always set error state if it throws.
  return pollers.map((p) => ({
    ...p,
    runOnce: async () => {
      try {
        await p.runOnce();
      } catch (e: any) {
        markIntegrationError(db, p.name, e?.message ?? String(e));
        throw e;
      }
    }
  }));
}

export function startPollLoop(db: Db, opts: { logger: { info: Function; warn: Function }; intervalSeconds?: number }) {
  const cfg = loadConfig();
  const intervalMs = (opts.intervalSeconds ?? cfg.POLL_INTERVAL_SECONDS) * 1000;
  const pollers = createPollers(db);

  async function tick() {
    for (const p of pollers) {
      try {
        await p.runOnce();
      } catch (e: any) {
        opts.logger.warn({ err: e, poller: p.name }, "Poller run failed");
      }
    }
  }

  void tick();
  return setInterval(() => void tick(), intervalMs);
}

