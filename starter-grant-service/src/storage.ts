import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PersistedStarterGrantState, StarterGrantStore } from "./types.js";

const INITIAL_STATE: PersistedStarterGrantState = {
  challenges: [],
  claims: [],
  audits: [],
  rateLimits: []
};

export class StarterGrantFileStore implements StarterGrantStore {
  private queue = Promise.resolve();

  constructor(private readonly statePath: string) {}

  async transact<T>(updater: (state: PersistedStarterGrantState) => Promise<T> | T): Promise<T> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      const state = await this.load();
      let result!: T;
      let failure: unknown;

      try {
        result = await updater(state);
      } catch (error) {
        failure = error;
      }

      await this.save(state);

      if (failure !== undefined) {
        throw failure;
      }

      return result;
    });

    this.queue = operation.then(
      () => undefined,
      () => undefined
    );

    return operation;
  }

  private async load(): Promise<PersistedStarterGrantState> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedStarterGrantState>;
      return {
        challenges: parsed.challenges ?? [],
        claims: parsed.claims ?? [],
        audits: parsed.audits ?? [],
        rateLimits: parsed.rateLimits ?? []
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return structuredClone(INITIAL_STATE);
      }

      throw error;
    }
  }

  private async save(state: PersistedStarterGrantState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tempPath, this.statePath);
  }
}
