import { ClientPrefix, Method } from 'matrix-js-sdk/lib/http-api';
import { encodeUri } from 'matrix-js-sdk/lib/utils';
import type { KeyBackupSession } from 'matrix-js-sdk/lib/crypto-api/keybackup';
import type { MatrixClient } from '$types/matrix-sdk';

export const BACKOFF_TIME_MS = 5000;

export type SessionRef = { roomId: string; sessionId: string };

export type BackupDownloadHost = {
  mx: MatrixClient;
  getBackupVersion: () => Promise<string | null>;
  importSession: (roomId: string, session: KeyBackupSession) => Promise<boolean>;
  now: () => number;
};

export class PerSessionBackupDownloader {
  readonly #host: BackupDownloadHost;

  readonly #queue: SessionRef[] = [];

  readonly #queued = new Set<string>();

  readonly #missingUntil = new Map<string, number>();

  #running = false;

  #stopped = false;

  #pausedUntil = 0;

  constructor(host: BackupDownloadHost) {
    this.#host = host;
  }

  stop(): void {
    this.#stopped = true;
    this.#queue.length = 0;
    this.#queued.clear();
  }

  resume(): void {
    this.#missingUntil.clear();
    this.#pausedUntil = 0;
  }

  request(ref: SessionRef): void {
    if (this.#stopped) return;

    const key = `${ref.roomId}|${ref.sessionId}`;
    if (this.#queued.has(key)) return;

    const retryAt = this.#missingUntil.get(key);
    if (retryAt !== undefined && this.#host.now() < retryAt) return;

    this.#queued.add(key);
    this.#queue.push(ref);
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;

    try {
      while (!this.#stopped) {
        const ref = this.#queue.shift();
        if (!ref) break;

        const wait = this.#pausedUntil - this.#host.now();
        if (wait > 0) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => {
            setTimeout(resolve, wait);
          });
        }
        if (this.#stopped) break;

        // eslint-disable-next-line no-await-in-loop
        await this.#fetchOne(ref);
        this.#queued.delete(`${ref.roomId}|${ref.sessionId}`);
      }
    } finally {
      this.#running = false;
    }
  }

  async #fetchOne(ref: SessionRef): Promise<void> {
    const key = `${ref.roomId}|${ref.sessionId}`;
    const path = encodeUri('/room_keys/keys/$roomId/$sessionId', {
      $roomId: ref.roomId,
      $sessionId: ref.sessionId,
    });

    const version = await this.#host.getBackupVersion();
    if (!version) {
      this.#missingUntil.set(key, this.#host.now() + BACKOFF_TIME_MS);
      return;
    }

    try {
      const session = await this.#host.mx.http.authedRequest<KeyBackupSession>(
        Method.Get,
        path,
        { version },
        undefined,
        { prefix: ClientPrefix.V3 }
      );
      const imported = await this.#host.importSession(ref.roomId, session);
      if (!imported) this.#missingUntil.set(key, this.#host.now() + BACKOFF_TIME_MS);
    } catch (error) {
      const failure = error as {
        httpStatus?: number;
        data?: { errcode?: string; retry_after_ms?: number };
      };

      if (failure.data?.errcode === 'M_LIMIT_EXCEEDED') {
        const after = failure.data.retry_after_ms ?? BACKOFF_TIME_MS;
        this.#pausedUntil = this.#host.now() + after;
        this.#requeue(ref);
        return;
      }

      this.#missingUntil.set(key, this.#host.now() + BACKOFF_TIME_MS);
    }
  }

  #requeue(ref: SessionRef): void {
    this.#queue.push(ref);
  }
}
