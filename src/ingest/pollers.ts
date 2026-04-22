import type { Db } from "../db/db.js";
import { loadConfig } from "../config.js";
import { markIntegrationError } from "../db/repos/integrationsRepo.js";
import { arrPing } from "../integrations/arr.js";
import { pollRadarrQueue, pollSonarrQueue } from "./pollers/arrPollers.js";
import { pollSabnzbd } from "./pollers/sabnzbdPoller.js";
import { pollTautulli } from "./pollers/tautulliPoller.js";
import { pollSeerr } from "./pollers/seerrPoller.js";

export type Poller = {
  name: string;
  runOnce: () => Promise<void>;
};

export function createPollers(db: Db): Poller[] {
  const cfg = loadConfig();

  const pollers: Poller[] = [];

  pollers.push({
    name: "seerr",
    runOnce: async () => {
      await pollSeerr(db, cfg);
    }
  });
  pollers.push({
    name: "sonarr",
    runOnce: async () => {
      if (!cfg.SONARR_BASE_URL || !cfg.SONARR_API_KEY) return;
      await arrPing({ baseUrl: cfg.SONARR_BASE_URL, apiKey: cfg.SONARR_API_KEY });
      await pollSonarrQueue(db, cfg);
    }
  });
  pollers.push({
    name: "radarr",
    runOnce: async () => {
      if (!cfg.RADARR_BASE_URL || !cfg.RADARR_API_KEY) return;
      await arrPing({ baseUrl: cfg.RADARR_BASE_URL, apiKey: cfg.RADARR_API_KEY });
      await pollRadarrQueue(db, cfg);
    }
  });
  pollers.push({
    name: "sabnzbd",
    runOnce: async () => {
      await pollSabnzbd(db, cfg);
    }
  });
  pollers.push({
    name: "tautulli",
    runOnce: async () => {
      await pollTautulli(db, cfg);
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

export async function runAllPollersOnce(db: Db) {
  const pollers = createPollers(db);
  for (const p of pollers) {
    try {
      await p.runOnce();
    } catch {
      // Errors are recorded per-integration via markIntegrationError inside the wrapper.
    }
  }
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

