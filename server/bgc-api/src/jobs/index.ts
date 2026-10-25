// Every background job, by name. The worker (server.ts) schedules the ones with a schedule and answers POST /run/<name>;
// the API hands its slow work here (jobsClient.ts) and runs the same functions itself when there's no worker.
import { aiUsage } from './aiUsage.js';
import { fillCatalog } from './fillCatalog.js';
import { healthCheck } from './healthCheck.js';
import { memberPlays, memberPlaysNightly } from './memberPlays.js';
import { ruleReader } from './ruleReader.js';
import { selfTest } from './selfTest.js';
import { shelfCsv } from './shelfCsv.js';
import { syncPeople } from './syncPeople.js';
import { syncPlays } from './syncPlays.js';
import type { Job } from './types.js';

export const JOBS: Job[] = [syncPlays, syncPeople, memberPlays, memberPlaysNightly, fillCatalog, ruleReader, healthCheck, aiUsage, selfTest, shelfCsv];
