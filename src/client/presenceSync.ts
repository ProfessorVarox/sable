import type { CryptoBackend, IDeviceLists, IToDeviceEvent, MatrixClient } from '$types/matrix-sdk';
import {
  ClientEvent,
  Filter,
  Method,
  processToDeviceMessages,
  SetPresence,
  User,
} from '$types/matrix-sdk';
import { createDebugLogger } from '$utils/debugLogger';

const debugLog = createDebugLogger('presenceSync');

type PresenceSyncResponse = {
  next_batch?: string;
  presence?: { events?: unknown[] };
  to_device?: { events?: IToDeviceEvent[] };
  device_lists?: IDeviceLists;
  device_one_time_keys_count?: Record<string, number>;
  device_unused_fallback_key_types?: string[];
  'org.matrix.msc2732.device_unused_fallback_key_types'?: string[];
};

export class PresenceSyncManager {
  private disposed = false;

  private enabled = true;

  private started = false;

  private presence = SetPresence.Online;

  private restartAfterRequest = false;

  private activeRequest: Promise<void> | null = null;

  private abortController: AbortController | undefined;

  private nextPollTimer: ReturnType<typeof setTimeout> | undefined;

  private syncToken: string | undefined;

  public constructor(
    private readonly mx: MatrixClient,
    private readonly pollTimeoutMs: number = 30000,
    private readonly pollingIntervalMs: number = 20000
  ) {
    debugLog.info('sync', 'PresenceSyncManager initialized');
  }

  public setPresenceEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;

    if (!enabled) {
      this.restartAfterRequest = false;
      if (this.nextPollTimer !== undefined) clearTimeout(this.nextPollTimer);
      this.nextPollTimer = undefined;
      this.abortController?.abort();
      return;
    }

    if (this.started && !this.activeRequest && !this.disposed) this.poll();
  }

  public setPresence(presence: SetPresence = SetPresence.Online): void {
    if (this.presence === presence) return;
    this.presence = presence;

    if (!this.started || !this.enabled || this.disposed) return;
    if (this.activeRequest) {
      this.restartAfterRequest = true;
      this.abortController?.abort();
    } else {
      this.poll();
    }
  }

  public start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    if (!this.enabled) return;
    this.poll();
  }

  public dispose(): void {
    this.disposed = true;
    this.enabled = false;
    this.started = false;
    if (this.nextPollTimer !== undefined) clearTimeout(this.nextPollTimer);
    this.nextPollTimer = undefined;
    this.abortController?.abort();
  }

  private async processCrypto(response: PresenceSyncResponse): Promise<void> {
    const crypto = this.mx.getCrypto() as CryptoBackend | undefined;
    if (!crypto) return;

    const toDeviceEvents = response.to_device?.events ?? [];
    if (toDeviceEvents.length > 0) {
      const processedEvents = await crypto.preprocessToDeviceMessages(toDeviceEvents);
      processToDeviceMessages(processedEvents, this.mx);
    }

    if (response.device_lists) {
      await crypto.processDeviceLists(response.device_lists);
    }

    await crypto.processKeyCounts(
      response.device_one_time_keys_count,
      response.device_unused_fallback_key_types ??
        response['org.matrix.msc2732.device_unused_fallback_key_types']
    );
    crypto.onSyncCompleted({ nextSyncToken: response.next_batch });
  }

  private processPresence(response: PresenceSyncResponse): void {
    const events = response.presence?.events;
    if (!events || !Array.isArray(events)) return;

    const mapper = this.mx.getEventMapper();
    events.forEach((rawEvent) => {
      if (
        typeof rawEvent !== 'object' ||
        !rawEvent ||
        (rawEvent as Record<string, unknown>).type !== 'm.presence'
      )
        return;

      const presenceEvent = mapper(rawEvent);
      const userId =
        presenceEvent.getSender() ?? (presenceEvent.getContent().user_id as string | undefined);
      if (!userId) return;

      let user = this.mx.store.getUser(userId);
      if (!user) {
        user = User.createUser(userId, this.mx);
        this.mx.store.storeUser(user);
      }
      user.setPresenceEvent(presenceEvent);
      this.mx.emit(ClientEvent.Event, presenceEvent);
    });
  }

  private poll(): void {
    if (!this.enabled || this.disposed) return;

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    this.activeRequest = (async () => {
      try {
        const filter = new Filter(this.mx.getUserId());
        filter.setDefinition({
          room: { rooms: [] },
          account_data: { types: [] },
          presence: { types: ['m.presence'] },
        });

        const filterId = await this.mx.getOrCreateFilter('presence_only', filter);
        const response = await this.mx.http.authedRequest<PresenceSyncResponse>(
          Method.Get,
          '/sync',
          {
            filter: filterId,
            since: this.syncToken,
            timeout: this.pollTimeoutMs,
            set_presence: this.presence,
          },
          undefined,
          { abortSignal: signal }
        );

        await this.processCrypto(response);
        this.processPresence(response);
        this.syncToken = response.next_batch;

        debugLog.info('sync', 'Presence sync response processed', {
          presenceEvents: response.presence?.events?.length ?? 0,
          toDeviceEvents: response.to_device?.events?.length ?? 0,
          hasKeyCounts: response.device_one_time_keys_count !== undefined,
        });
      } catch (err) {
        if (!signal.aborted && !this.disposed) {
          debugLog.error('sync', 'Error during background presence sync', err);
        }
      }
    })();

    void this.activeRequest.finally(() => {
      this.activeRequest = null;
      this.abortController = undefined;

      if (this.restartAfterRequest && this.started && this.enabled && !this.disposed) {
        this.restartAfterRequest = false;
        this.poll();
      } else if (this.started && this.enabled && !this.disposed) {
        this.nextPollTimer = setTimeout(() => {
          this.nextPollTimer = undefined;
          this.poll();
        }, this.pollingIntervalMs);
      }
    });
  }
}
