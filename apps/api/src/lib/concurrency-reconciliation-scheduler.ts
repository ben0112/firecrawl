import type { Logger } from "winston";

interface ReconciliationSummary {
  teamsScanned: number;
  teamsWithDrift: number;
  jobsRequeued: number;
  jobsStarted: number;
}

type Reconcile = (options: {
  teamId?: string;
  logger?: Logger;
}) => Promise<ReconciliationSummary>;

interface TeamScheduleState {
  pending: boolean;
  logger: Logger;
  promise: Promise<void>;
}

export class ConcurrencyReconciliationScheduler {
  private readonly teams = new Map<string, TeamScheduleState>();

  constructor(private readonly reconcile: Reconcile) {}

  schedule(teamId: string, logger: Logger): void {
    const existing = this.teams.get(teamId);
    if (existing) {
      existing.pending = true;
      existing.logger = logger;
      return;
    }

    const state: TeamScheduleState = {
      pending: false,
      logger,
      promise: Promise.resolve(),
    };
    this.teams.set(teamId, state);
    state.promise = this.run(teamId, state);
  }

  async waitForIdle(teamId: string): Promise<void> {
    while (true) {
      const state = this.teams.get(teamId);
      if (!state) return;
      await state.promise;
    }
  }

  private async run(teamId: string, state: TeamScheduleState): Promise<void> {
    try {
      do {
        state.pending = false;
        try {
          const result = await this.reconcile({
            teamId,
            logger: state.logger,
          });
          state.logger.info("Deferred concurrency reconciliation complete", {
            teamId,
            ...result,
          });
        } catch (error) {
          state.logger.error("Deferred concurrency reconciliation failed", {
            teamId,
            error,
          });
        }
      } while (state.pending);
    } finally {
      if (this.teams.get(teamId) === state) {
        this.teams.delete(teamId);
      }
    }
  }
}
