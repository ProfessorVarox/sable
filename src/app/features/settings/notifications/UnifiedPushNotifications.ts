import {
  type CryptoBackend,
  type IPusherRequest,
  type MatrixClient,
  MatrixEvent,
} from '$types/matrix-sdk';
import { EventType } from 'matrix-js-sdk/lib/@types/event';
import {
  resolveNotificationPreviewText,
  ENCRYPTED_MESSAGE_PREVIEW,
} from '$utils/notificationStyle';
import { getMxIdLocalPart } from '$utils/matrix';
import { getStateEvent } from '$utils/room/hierarchy';
import { getMemberAvatarMxc } from '$utils/room/display';
import { createDebugLogger } from '$utils/debugLogger';
import {
  registerUnifiedPushTransport,
  type UnifiedPushRegistrationResult,
  unregisterUnifiedPushTransport,
} from './UnifiedPushTransport';
import {
  createUnifiedPushMessageListener,
  parseUnifiedPushMessage,
} from './UnifiedPushMessageListener';
import { addPluginListener, invoke } from '@tauri-apps/api/core';
import type { PushTransportConfig } from './NotificationTransport';
import { getTauriNotificationsApi, isMobileTauri } from './TauriNotificationsApiClient';
import {
  resolvePushNotifyUrl,
  withPushPayloadFormat,
  type PushPusherSettings,
} from './PushPusherConfig';

const UP_PUBLIC_GATEWAY = 'https://matrix.gateway.unifiedpush.org/_matrix/push/v1/notify';
export const DEFAULT_UNIFIED_PUSH_APP_ID = 'moe.sable.up';
const unifiedPushLog = createDebugLogger('unifiedpush');

/**
 * Shape of a UnifiedPush payload delivered to the message listener.
 * Fields are optional because both rich (full event) and minimal
 * (event_id + counts) payloads arrive through the same entry point.
 */
type UnifiedPushPayload = {
  type?: string;
  content?: Record<string, unknown>;
  room_id?: string;
  room_name?: string;
  sender_display_name?: string;
  sender?: string;
  event_id?: string;
  user_id?: string;
  counts?: { unread?: number };
  notification?: unknown;
  [key: string]: unknown;
};

const UP_REGISTER_TIMEOUT_MS = 30_000;

export type UnifiedPushTransportConfigInput = Pick<
  PushTransportConfig,
  'unifiedPushGatewayUrl' | 'unifiedPushAppID'
> & {
  vapidPublicKey?: string;
  webPushAppID?: string;
  pushNotifyUrl?: string;
} & PushPusherSettings;

type UnifiedPushPusherConfig = {
  appId: string;
  gatewayUrl?: string;
};

function trimConfigValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function resolveUnifiedPushPusherConfig(
  config?: UnifiedPushTransportConfigInput
): UnifiedPushPusherConfig {
  return {
    appId: trimConfigValue(config?.unifiedPushAppID) ?? DEFAULT_UNIFIED_PUSH_APP_ID,
    gatewayUrl: trimConfigValue(config?.unifiedPushGatewayUrl),
  };
}

export type EnableUnifiedPushResult =
  | {
      status: 'registered';
      endpoint: string;
      gatewayUrl: string;
      distributor: string;
    }
  | Exclude<UnifiedPushRegistrationResult, { status: 'registered' }>;

async function registerUnifiedPushWithTimeout(
  vapid?: string
): Promise<UnifiedPushRegistrationResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('UnifiedPush registration timed out'));
    }, UP_REGISTER_TIMEOUT_MS);
  });

  try {
    return await Promise.race([registerUnifiedPushTransport(vapid), timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export async function tryEnableUnifiedPush(
  mx: MatrixClient,
  config?: UnifiedPushTransportConfigInput
): Promise<EnableUnifiedPushResult> {
  const notificationsApi = await getTauriNotificationsApi();

  await notificationsApi.createChannel({
    id: 'messages',
    name: 'Messages',
    description: 'Matrix message and invite notifications',
    importance: notificationsApi.Importance.Default,
    vibration: true,
  });

  const registration = await registerUnifiedPushWithTimeout(config?.vapidPublicKey);

  if (registration.status !== 'registered') {
    return registration;
  }

  const { endpoint } = registration;
  const deviceDisplayName =
    (await mx.getDevice(mx.getDeviceId() ?? ''))?.display_name ?? 'Android Device';

  if (registration.p256dh && registration.auth && config?.webPushAppID && config?.pushNotifyUrl) {
    const pushNotifyUrl = resolvePushNotifyUrl(config.pushNotifyUrl, config?.pushNotifyUrlOverride);
    await mx.setPusher({
      kind: 'http',
      app_id: config.webPushAppID,
      pushkey: registration.p256dh,
      app_display_name: 'Sable (UnifiedPush)',
      device_display_name: deviceDisplayName,
      lang: navigator.language || 'en',
      data: withPushPayloadFormat(
        {
          url: pushNotifyUrl,
          endpoint,
          p256dh: registration.p256dh,
          auth: registration.auth,
          default_payload: { user_id: mx.getSafeUserId() },
        },
        config?.useRichPushPayloads
      ),
      append: false,
    } as unknown as IPusherRequest);

    return {
      status: 'registered',
      endpoint,
      gatewayUrl: pushNotifyUrl,
      distributor: registration.distributor,
    };
  }

  const resolvedConfig = resolveUnifiedPushPusherConfig(config);
  const gatewayUrl = resolvedConfig.gatewayUrl ?? UP_PUBLIC_GATEWAY;

  await mx.setPusher({
    kind: 'http',
    app_id: resolvedConfig.appId,
    pushkey: endpoint,
    app_display_name: 'Sable (UnifiedPush)',
    device_display_name: deviceDisplayName,
    lang: navigator.language || 'en',
    data: withPushPayloadFormat(
      { url: gatewayUrl, default_payload: { user_id: mx.getSafeUserId() } },
      config?.useRichPushPayloads
    ),
    append: false,
  } as unknown as IPusherRequest);

  return {
    status: 'registered',
    endpoint,
    gatewayUrl,
    distributor: registration.distributor,
  };
}

export async function enableUnifiedPush(
  mx: MatrixClient,
  config?: UnifiedPushTransportConfigInput
): Promise<{ endpoint: string; gatewayUrl: string }> {
  const result = await tryEnableUnifiedPush(mx, config);
  if (result.status !== 'registered') {
    throw new Error(result.error ?? 'UnifiedPush registration failed');
  }

  return {
    endpoint: result.endpoint,
    gatewayUrl: result.gatewayUrl,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function getCurrentDeviceUnifiedPushPushkeys(
  mx: MatrixClient,
  appId: string
): Promise<string[]> {
  const deviceId = mx.getDeviceId() ?? '';
  if (!deviceId) {
    return [];
  }

  const currentDevice = await mx.getDevice(deviceId);
  const deviceDisplayName = currentDevice?.display_name;
  if (!deviceDisplayName) {
    return [];
  }

  const response = await mx.getPushers();
  const pushers = response.pushers ?? [];
  return pushers
    .filter(
      (pusher) =>
        pusher.app_id === appId &&
        pusher.device_display_name === deviceDisplayName &&
        pusher.kind === 'http' &&
        isNonEmptyString(pusher.pushkey)
    )
    .map((pusher) => pusher.pushkey);
}

async function getUnifiedPushCleanupPushkeys(
  mx: MatrixClient,
  appId: string,
  pushkey?: string
): Promise<string[]> {
  const pushkeys = new Set<string>();

  if (isNonEmptyString(pushkey)) {
    pushkeys.add(pushkey);
  }

  const currentDevicePushkeys = await getCurrentDeviceUnifiedPushPushkeys(mx, appId);
  currentDevicePushkeys.forEach((candidate) => pushkeys.add(candidate));

  return Array.from(pushkeys);
}

export type DisableUnifiedPushOptions = {
  config?: UnifiedPushTransportConfigInput;
  pushkey?: string;
};

export async function disableUnifiedPush(
  mx: MatrixClient,
  options: DisableUnifiedPushOptions = {}
): Promise<void> {
  const { appId } = resolveUnifiedPushPusherConfig(options.config);
  const pushkeys = await getUnifiedPushCleanupPushkeys(mx, appId, options.pushkey);

  await Promise.allSettled(
    pushkeys.map((pushkey) =>
      mx.setPusher({
        kind: null,
        app_id: appId,
        pushkey,
      } as unknown as IPusherRequest)
    )
  );

  const webPushAppId = trimConfigValue(options.config?.webPushAppID);
  if (webPushAppId && webPushAppId !== appId) {
    const webPushKeys = await getCurrentDeviceUnifiedPushPushkeys(mx, webPushAppId);
    await Promise.allSettled(
      webPushKeys.map((pushkey) =>
        mx.setPusher({
          kind: null,
          app_id: webPushAppId,
          pushkey,
        } as unknown as IPusherRequest)
      )
    );
  }

  await unregisterUnifiedPushTransport();
}

type NotificationSettings = {
  mx: MatrixClient;
  showMessageContent: boolean;
  showEncryptedMessageContent: boolean;
  notificationSoundEnabled: boolean;
  useInAppNotifications: boolean;
};

const NOTIF_GROUP_KEY = 'matrix_messages';
const MAX_MESSAGES = 10;
const MAX_SEEN_EVENT_IDS = 200;
const ENCRYPTED_PREVIEW_OBSERVATION_DEADLINE_MS = 2_500;

type NotifPerson = {
  name: string;
  key?: string;
  iconUrl?: string;
};

type NotifMessage = {
  text: string;
  timestamp: number;
  sender?: NotifPerson;
};

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    // eslint-disable-next-line no-bitwise
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

async function resolvePreviewEvent(
  mx: MatrixClient,
  roomId: string,
  eventId: string
): Promise<MatrixEvent | undefined> {
  try {
    const evt = await mx.fetchRoomEvent(roomId, eventId);
    const mEvent = new MatrixEvent(evt);
    if (mEvent.isEncrypted() && mx.getCrypto()) {
      await mEvent.attemptDecryption(mx.getCrypto() as CryptoBackend);
    }
    return mEvent;
  } catch (error) {
    unifiedPushLog.warn(
      'notification',
      'Failed to fetch/decrypt event for push preview',
      error instanceof Error ? error : new Error(String(error))
    );
    return undefined;
  }
}

/**
 * Decrypts the ciphertext from a rich push payload locally — no homeserver
 * fetch needed. The Megolm session keys are in the crypto store. This is
 * what makes encrypted notifications as fast as Element.
 */
async function decryptPreviewFromPayload(
  mx: MatrixClient,
  roomId: string,
  eventId: string,
  pushData: UnifiedPushPayload
): Promise<MatrixEvent | undefined> {
  const crypto = mx.getCrypto();
  if (!crypto || !pushData.content) return undefined;
  const mEvent = new MatrixEvent({
    type: 'm.room.encrypted',
    content: pushData.content,
    room_id: roomId,
    event_id: eventId,
    sender: pushData.sender,
    origin_server_ts: Date.now(),
  });
  await mEvent.attemptDecryption(crypto as CryptoBackend);
  if (mEvent.isDecryptionFailure()) throw new Error('Encrypted preview decryption failed');
  return mEvent;
}

const roomNotifId = (userId: string, roomId: string) => hashCode(`${userId}\u0000${roomId}`);
const summaryNotifId = (userId: string) => hashCode(`sable-group-summary\u0000${userId}`);

type RoomNotifCache = {
  key: string;
  generation: number;
  roomName: string;
  messages: NotifMessage[];
  pendingEventIds: Set<string>;
  seenEventIds: Set<string>;
  isGroupConversation: boolean;
};

const roomNotifCaches = new Map<string, RoomNotifCache>();
const roomNotifGenerations = new Map<string, number>();
const roomNotifQueues = new Map<string, Promise<void>>();
const accountSummaryQueues = new Map<string, Promise<void>>();

function enqueueRoomOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = roomNotifQueues.get(key) ?? Promise.resolve();
  const task = previous.then(operation, operation);
  const completion = task.then(
    () => undefined,
    () => undefined
  );
  roomNotifQueues.set(key, completion);
  void completion.then(() => {
    if (roomNotifQueues.get(key) === completion) roomNotifQueues.delete(key);
  });
  return task;
}

function enqueueAccountSummaryOperation<T>(
  userId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = accountSummaryQueues.get(userId) ?? Promise.resolve();
  const task = previous.then(operation, operation);
  const completion = task.then(
    () => undefined,
    () => undefined
  );
  accountSummaryQueues.set(userId, completion);
  void completion.then(() => {
    if (accountSummaryQueues.get(userId) === completion) accountSummaryQueues.delete(userId);
  });
  return task;
}

function resolveAvatarUrl(mx: MatrixClient, roomId: string, userId: string): string | undefined {
  const room = mx.getRoom(roomId);
  if (!room) return undefined;
  const mxcUrl = getMemberAvatarMxc(room, userId);
  if (!mxcUrl) return undefined;
  return mx.mxcUrlToHttp(mxcUrl, 96, 96, 'crop', false, true, true) ?? undefined;
}

function getOrCreateRoomCache(userId: string, roomId: string, roomName: string): RoomNotifCache {
  const key = `${userId}\u0000${roomId}`;
  let cache = roomNotifCaches.get(key);
  if (!cache) {
    cache = {
      key,
      generation: roomNotifGenerations.get(key) ?? 0,
      roomName,
      messages: [],
      pendingEventIds: new Set(),
      seenEventIds: new Set(),
      isGroupConversation: false,
    };
    roomNotifCaches.set(key, cache);
  }
  cache.roomName = roomName;
  return cache;
}

function isCurrentRoomCache(cache: RoomNotifCache): boolean {
  return (
    roomNotifCaches.get(cache.key) === cache &&
    (roomNotifGenerations.get(cache.key) ?? 0) === cache.generation
  );
}

export function resetUnifiedPushNotificationStateForTests(): void {
  roomNotifCaches.clear();
  roomNotifGenerations.clear();
  roomNotifQueues.clear();
  accountSummaryQueues.clear();
}

async function refreshAccountSummary(
  userId: string,
  removeWhenEmpty: boolean,
  isCurrent?: () => boolean
): Promise<void> {
  await enqueueAccountSummaryOperation(userId, async () => {
    let notificationsApi: Awaited<ReturnType<typeof getTauriNotificationsApi>>;
    try {
      notificationsApi = await getTauriNotificationsApi();
    } catch {
      return;
    }
    if (isCurrent && !isCurrent()) return;

    const accountCaches = Array.from(roomNotifCaches.entries()).filter(([key]) =>
      key.startsWith(`${userId}\u0000`)
    );
    const roomCount = accountCaches.length;
    if (roomCount <= 1) {
      if (removeWhenEmpty) {
        try {
          await notificationsApi.removeActive([{ id: summaryNotifId(userId) }]);
        } catch {
          // already dismissed
        }
      }
      return;
    }

    const totalMessages = accountCaches
      .map(([, accountCache]) => accountCache)
      .reduce((sum, accountCache) => sum + accountCache.messages.length, 0);
    const summaryText = `${totalMessages} messages in ${roomCount} chats`;
    const summaryLines: string[] = [];
    accountCaches.forEach(([, accountCache]) => {
      const latest = accountCache.messages[accountCache.messages.length - 1];
      if (latest) {
        summaryLines.push(
          `${accountCache.roomName}: ${latest.sender?.name ?? 'You'}: ${latest.text}`
        );
      }
    });

    if (isCurrent && !isCurrent()) return;
    try {
      await notificationsApi.sendNotification({
        id: summaryNotifId(userId),
        title: summaryText,
        body: '',
        summary: summaryText,
        inboxLines: summaryLines.slice(-5),
        channelId: 'messages',
        group: NOTIF_GROUP_KEY,
        groupSummary: true,
        icon: 'notification_icon',
        silent: true,
        autoCancel: true,
      });
    } catch {
      // The room notification was already posted; a summary is best effort.
    }
  });
}

/** Clears accumulated messages for a room and dismisses its notification. */
export async function clearRoomNotification(userId: string, roomId: string) {
  const key = `${userId}\u0000${roomId}`;
  await enqueueRoomOperation(key, async () => {
    roomNotifCaches.delete(key);
    roomNotifGenerations.set(key, (roomNotifGenerations.get(key) ?? 0) + 1);
    try {
      const notificationsApi = await getTauriNotificationsApi();
      await notificationsApi.removeActive([{ id: roomNotifId(userId, roomId) }]);
    } catch {
      // already dismissed
    }
    await refreshAccountSummary(userId, true);
  });
}

async function postRoomNotification(
  userId: string,
  roomId: string,
  cache: RoomNotifCache,
  isSilent: boolean,
  extra: Record<string, unknown>,
  isCurrent?: () => boolean
): Promise<boolean> {
  const notificationsApi = await getTauriNotificationsApi();
  if (isCurrent && !isCurrent()) return false;
  const { messages, roomName } = cache;
  const latestMsg = messages[messages.length - 1];
  const latestBody = latestMsg ? `${latestMsg.sender?.name ?? 'You'}: ${latestMsg.text}` : '';

  const inboxLines = messages.slice(-5).map((m) => `${m.sender?.name ?? 'You'}: ${m.text}`);

  await notificationsApi.sendNotification({
    id: roomNotifId(userId, roomId),
    title: roomName,
    body: latestBody,
    channelId: 'messages',
    group: NOTIF_GROUP_KEY,
    icon: 'notification_icon',
    silent: isSilent,
    autoCancel: true,
    extra,
    ...(isMobileTauri() ? { actionTypeId: 'sable-message' } : {}),
    inboxLines: inboxLines.length > 1 ? inboxLines : undefined,
    largeBody: inboxLines.length > 1 ? undefined : latestBody,
  });
  await refreshAccountSummary(userId, false, isCurrent);
  return true;
}

/** Handles a rich push payload containing full event details (type, room_name, content, etc.). */
async function handleRichPushPayload(
  pushData: UnifiedPushPayload,
  settings: NotificationSettings,
  userId: string,
  getSettings: () => NotificationSettings
) {
  const eventType = pushData.type as EventType;

  switch (eventType) {
    case EventType.RoomMessage:
    case EventType.Sticker:
    case EventType.RoomMessageEncrypted: {
      const isEncrypted = eventType === EventType.RoomMessageEncrypted;

      let previewText = resolveNotificationPreviewText({
        content: pushData?.content,
        eventType: pushData?.type,
        isEncryptedRoom: isEncrypted,
        showMessageContent: settings.showMessageContent,
        showEncryptedMessageContent: settings.showEncryptedMessageContent,
      });

      const roomId: string | undefined = pushData?.room_id;
      const roomName: string =
        pushData?.room_name ?? pushData?.sender_display_name ?? 'Unknown Room';
      const senderName: string | undefined = pushData?.sender_display_name;
      const senderId: string | undefined = pushData?.sender;
      const isSilent = !settings.notificationSoundEnabled;

      if (!roomId) {
        const notificationsApi = await getTauriNotificationsApi();
        await notificationsApi.sendNotification({
          title: roomName,
          body: senderName ? `${senderName}: ${previewText}` : previewText,
          channelId: 'messages',
          icon: 'notification_icon',
          silent: isSilent,
          autoCancel: true,
        });
        break;
      }

      const eventId: string | undefined = pushData?.event_id;

      let needsEncryptedPreviewEnrichment = false;

      if (
        previewText === ENCRYPTED_MESSAGE_PREVIEW &&
        eventId &&
        settings.showMessageContent &&
        settings.showEncryptedMessageContent
      ) {
        // Try local timeline first (decryption already done by SDK).
        const room = settings.mx.getRoom(roomId);
        const mEvent = room
          ?.getLiveTimeline()
          .getEvents()
          .find((e) => e.getId() === eventId);
        if (mEvent) {
          previewText = resolveNotificationPreviewText({
            content: mEvent.getContent(),
            eventType: mEvent.getType(),
            isEncryptedRoom: true,
            showMessageContent: settings.showMessageContent,
            showEncryptedMessageContent: settings.showEncryptedMessageContent,
          });
          needsEncryptedPreviewEnrichment =
            mEvent.getType() === EventType.RoomMessageEncrypted.toString();
        } else {
          needsEncryptedPreviewEnrichment = true;
        }
      }

      const sender: NotifPerson | undefined = senderName
        ? {
            name: senderName,
            key: senderId,
            iconUrl: senderId ? resolveAvatarUrl(settings.mx, roomId, senderId) : undefined,
          }
        : undefined;

      const message: NotifMessage = {
        text: previewText,
        timestamp: Date.now(),
        sender,
      };

      const key = `${userId}\u0000${roomId}`;
      let enrichmentCache: RoomNotifCache | undefined;
      let enrichmentMessage: NotifMessage | undefined;
      const posted = await enqueueRoomOperation(key, async () => {
        const cache = getOrCreateRoomCache(userId, roomId, roomName);
        if (eventId && (cache.pendingEventIds.has(eventId) || cache.seenEventIds.has(eventId))) {
          return false;
        }
        if (eventId) cache.pendingEventIds.add(eventId);
        const previousMessages = cache.messages.slice();
        cache.messages.push(message);
        if (cache.messages.length > MAX_MESSAGES) {
          cache.messages = cache.messages.slice(-MAX_MESSAGES);
        }

        const currentRoom = settings.mx.getRoom(roomId);
        if (currentRoom) {
          cache.isGroupConversation = (currentRoom.getJoinedMemberCount() ?? 0) > 2;
        }

        try {
          await postRoomNotification(userId, roomId, cache, isSilent, {
            room_id: roomId,
            event_id: pushData?.event_id,
            user_id: pushData?.user_id,
          });
        } catch {
          cache.messages = previousMessages;
          if (eventId) cache.pendingEventIds.delete(eventId);
          if (cache.messages.length === 0) roomNotifCaches.delete(cache.key);
          await refreshAccountSummary(userId, true);
          unifiedPushLog.warn('notification', 'UnifiedPush baseline notification failed');
          return false;
        }

        if (eventId) {
          cache.pendingEventIds.delete(eventId);
          cache.seenEventIds.add(eventId);
          if (cache.seenEventIds.size > MAX_SEEN_EVENT_IDS) {
            const oldest = cache.seenEventIds.values().next().value;
            if (oldest !== undefined) cache.seenEventIds.delete(oldest);
          }
        }
        enrichmentCache = cache;
        enrichmentMessage = message;
        return true;
      });

      if (
        posted &&
        needsEncryptedPreviewEnrichment &&
        eventId &&
        enrichmentCache &&
        enrichmentMessage
      ) {
        scheduleEncryptedPreviewEnrichment(
          pushData,
          roomId,
          eventId,
          enrichmentCache,
          enrichmentMessage,
          userId,
          getSettings
        );
      }
      break;
    }
    case EventType.RoomMember: {
      if (pushData?.content?.membership !== 'invite') break;
      const senderName: string | undefined = pushData?.sender_display_name;
      const roomName: string | undefined = pushData?.room_name;
      let body = '';
      if (senderName && roomName) body = `${senderName} invites you to ${roomName}`;
      else if (senderName) body = `from ${senderName}`;
      else if (roomName) body = `to ${roomName}`;

      const notificationsApi = await getTauriNotificationsApi();
      await notificationsApi.sendNotification({
        title: 'New Invitation',
        body,
        largeBody: body,
        channelId: 'messages',
        group: NOTIF_GROUP_KEY,
        icon: 'notification_icon',
        autoCancel: true,
        extra: {
          type: 'invite',
          room_id: pushData?.room_id,
          event_id: pushData?.event_id,
          user_id: pushData?.user_id,
        },
      });
      break;
    }
    default:
      break;
  }
}

function scheduleEncryptedPreviewEnrichment(
  pushData: UnifiedPushPayload,
  roomId: string,
  eventId: string,
  cache: RoomNotifCache,
  message: NotifMessage,
  userId: string,
  getSettings: () => NotificationSettings
): void {
  const initialSettings = getSettings();
  if (!initialSettings.showMessageContent || !initialSettings.showEncryptedMessageContent) return;

  let settled = false;
  let deadlineExpired = false;
  const deadlineTimer = setTimeout(() => {
    if (!settled) {
      deadlineExpired = true;
      unifiedPushLog.warn(
        'notification',
        'Encrypted preview decryption exceeded observation deadline'
      );
    }
  }, ENCRYPTED_PREVIEW_OBSERVATION_DEADLINE_MS);

  const enrichment = decryptPreviewFromPayload(initialSettings.mx, roomId, eventId, pushData);
  void enrichment
    .then(async (decrypted) => {
      if (deadlineExpired || !decrypted) return;

      await enqueueRoomOperation(cache.key, async () => {
        const liveSettings = getSettings();
        const isAllowed =
          liveSettings.showMessageContent &&
          liveSettings.showEncryptedMessageContent &&
          !(document.visibilityState === 'visible' && liveSettings.useInAppNotifications);
        if (!isAllowed || !isCurrentRoomCache(cache) || !cache.messages.includes(message)) {
          return;
        }

        const enrichedPreview = resolveNotificationPreviewText({
          content: decrypted.getContent(),
          eventType: decrypted.getType(),
          isEncryptedRoom: true,
          showMessageContent: liveSettings.showMessageContent,
          showEncryptedMessageContent: liveSettings.showEncryptedMessageContent,
        });
        if (!enrichedPreview || enrichedPreview === ENCRYPTED_MESSAGE_PREVIEW) return;

        const liveRoom = liveSettings.mx.getRoom(roomId);
        const decryptedSender = decrypted.getSender();
        const senderName = decryptedSender
          ? (liveRoom?.getMember(decryptedSender)?.name ??
            getMxIdLocalPart(decryptedSender) ??
            decryptedSender)
          : undefined;
        const previousText = message.text;
        const previousSender = message.sender;
        message.text = enrichedPreview;
        message.sender = senderName
          ? {
              name: senderName,
              key: decryptedSender,
              iconUrl: decryptedSender
                ? resolveAvatarUrl(liveSettings.mx, roomId, decryptedSender)
                : undefined,
            }
          : message.sender;

        const current = () => {
          const currentSettings = getSettings();
          return (
            isCurrentRoomCache(cache) &&
            cache.messages.includes(message) &&
            currentSettings.showMessageContent &&
            currentSettings.showEncryptedMessageContent &&
            !(document.visibilityState === 'visible' && currentSettings.useInAppNotifications)
          );
        };
        try {
          const posted = await postRoomNotification(
            userId,
            roomId,
            cache,
            true,
            {
              room_id: roomId,
              event_id: eventId,
              user_id: pushData?.user_id,
            },
            current
          );
          if (!posted) {
            message.text = previousText;
            message.sender = previousSender;
          }
        } catch {
          message.text = previousText;
          message.sender = previousSender;
        }
      });
    })
    .catch(() => {
      unifiedPushLog.warn('notification', 'Encrypted preview decryption failed');
    })
    .finally(() => {
      settled = true;
      clearTimeout(deadlineTimer);
    });
}

/**
 * Handles a minimal push payload (event_id + room_id + counts) from
 * the public UnifiedPush gateway, looking up context from local SDK state.
 */
async function handleMinimalPushPayload(
  pushData: UnifiedPushPayload,
  settings: NotificationSettings,
  userId: string,
  getSettings: () => NotificationSettings
) {
  const roomId: string | undefined = pushData?.room_id;
  const eventId: string | undefined = pushData?.event_id;
  const unread: number | undefined =
    typeof pushData?.counts?.unread === 'number' ? pushData.counts.unread : undefined;

  if (!roomId) return;

  // Unread count of zero means the room was read — dismiss the notification.
  if (unread === 0) {
    await clearRoomNotification(userId, roomId);
    return;
  }

  const room = settings.mx.getRoom(roomId);
  const roomName = room?.name ?? pushData?.sender_display_name ?? 'Unknown Room';
  const isEncryptedRoom = room ? !!getStateEvent(room, EventType.RoomEncryption) : false;

  let senderName: string | undefined;
  let senderId: string | undefined;
  let previewText: string | undefined;
  if (room && eventId) {
    const timeline = room.getLiveTimeline().getEvents();
    const mEvent = timeline.find((e) => e.getId() === eventId);
    if (mEvent) {
      const sender = mEvent.getSender();
      if (sender) {
        const member = room.getMember(sender);
        senderName = member?.name ?? getMxIdLocalPart(sender) ?? sender;
        senderId = sender;
      }

      previewText = resolveNotificationPreviewText({
        content: mEvent.getContent(),
        eventType: mEvent.getType(),
        isEncryptedRoom,
        showMessageContent: settings.showMessageContent,
        showEncryptedMessageContent: settings.showEncryptedMessageContent,
      });
    }
  }

  const hasInMemoryPreview = Boolean(previewText);
  if (!previewText) {
    previewText = isEncryptedRoom ? 'Encrypted message' : 'New message';
  }

  const sender: NotifPerson | undefined = senderName
    ? {
        name: senderName,
        key: senderId,
        iconUrl: senderId && roomId ? resolveAvatarUrl(settings.mx, roomId, senderId) : undefined,
      }
    : undefined;

  const message: NotifMessage = {
    text: previewText,
    timestamp: Date.now(),
    sender,
  };

  const key = `${userId}\u0000${roomId}`;
  let baselineCache: RoomNotifCache | undefined;
  const posted = await enqueueRoomOperation(key, async () => {
    const cache = getOrCreateRoomCache(userId, roomId, roomName);
    if (eventId && (cache.pendingEventIds.has(eventId) || cache.seenEventIds.has(eventId)))
      return false;
    if (eventId) cache.pendingEventIds.add(eventId);
    const previousMessages = cache.messages.slice();
    cache.messages.push(message);
    if (cache.messages.length > MAX_MESSAGES) {
      cache.messages = cache.messages.slice(-MAX_MESSAGES);
    }

    if (room) {
      cache.isGroupConversation = (room.getJoinedMemberCount() ?? 0) > 2;
    }

    try {
      await postRoomNotification(userId, roomId, cache, !settings.notificationSoundEnabled, {
        room_id: roomId,
        event_id: eventId,
        user_id: pushData?.user_id,
      });
    } catch (error) {
      cache.messages = previousMessages;
      if (eventId) cache.pendingEventIds.delete(eventId);
      if (cache.messages.length === 0) roomNotifCaches.delete(cache.key);
      await refreshAccountSummary(userId, true);
      throw error;
    }

    if (eventId) {
      cache.pendingEventIds.delete(eventId);
      cache.seenEventIds.add(eventId);
      if (cache.seenEventIds.size > MAX_SEEN_EVENT_IDS) {
        const oldest = cache.seenEventIds.values().next().value;
        if (oldest !== undefined) cache.seenEventIds.delete(oldest);
      }
    }
    baselineCache = cache;
    return true;
  });
  if (!posted || !baselineCache) return;
  const cache = baselineCache;

  if (
    !hasInMemoryPreview &&
    eventId &&
    settings.showMessageContent &&
    (!isEncryptedRoom || settings.showEncryptedMessageContent)
  ) {
    resolvePreviewEvent(settings.mx, roomId, eventId)
      .then(async (fetched) => {
        if (!fetched) return;

        await enqueueRoomOperation(cache.key, async () => {
          const liveSettings = getSettings();
          const eventEncrypted = isEncryptedRoom || fetched.isEncrypted();
          const isAllowed =
            liveSettings.showMessageContent &&
            (!eventEncrypted || liveSettings.showEncryptedMessageContent) &&
            !(document.visibilityState === 'visible' && liveSettings.useInAppNotifications);
          if (!isAllowed || !isCurrentRoomCache(cache) || !cache.messages.includes(message)) {
            return;
          }

          const enrichedPreview = resolveNotificationPreviewText({
            content: fetched.getContent(),
            eventType: fetched.getType(),
            isEncryptedRoom: eventEncrypted,
            showMessageContent: liveSettings.showMessageContent,
            showEncryptedMessageContent: liveSettings.showEncryptedMessageContent,
          });
          if (!enrichedPreview) return;

          const fetchedSender = fetched.getSender();
          const liveRoom = liveSettings.mx.getRoom(roomId);
          const nextSenderName = fetchedSender
            ? (liveRoom?.getMember(fetchedSender)?.name ??
              getMxIdLocalPart(fetchedSender) ??
              fetchedSender)
            : undefined;
          const previousText = message.text;
          const previousSender = message.sender;
          message.text = enrichedPreview;
          message.sender = nextSenderName
            ? {
                name: nextSenderName,
                key: fetchedSender,
                iconUrl: fetchedSender
                  ? resolveAvatarUrl(liveSettings.mx, roomId, fetchedSender)
                  : undefined,
              }
            : sender;

          const current = () => {
            const currentSettings = getSettings();
            return (
              isCurrentRoomCache(cache) &&
              cache.messages.includes(message) &&
              currentSettings.showMessageContent &&
              (!eventEncrypted || currentSettings.showEncryptedMessageContent) &&
              !(document.visibilityState === 'visible' && currentSettings.useInAppNotifications)
            );
          };
          try {
            const sent = await postRoomNotification(
              userId,
              roomId,
              cache,
              true,
              {
                room_id: roomId,
                event_id: eventId,
                user_id: pushData?.user_id,
              },
              current
            );
            if (!sent) {
              message.text = previousText;
              message.sender = previousSender;
            }
          } catch {
            message.text = previousText;
            message.sender = previousSender;
          }
        });
      })
      .catch((error) => {
        unifiedPushLog.warn(
          'notification',
          'Background preview fetch failed',
          error instanceof Error ? error : new Error(String(error))
        );
      });
  }
}

async function handleUnifiedPushPayload(
  raw: Record<string, unknown>,
  getSettings: () => NotificationSettings
) {
  const settings = getSettings();

  // Skip system notification when in-app banners are active and visible.
  if (document.visibilityState === 'visible' && settings.useInAppNotifications) {
    return;
  }

  const pushData = (raw.extra ?? raw) as UnifiedPushPayload;
  const eventType = pushData?.type as EventType | undefined;
  const userId = pushData?.user_id ?? settings.mx.getUserId() ?? '';

  if (eventType) {
    await handleRichPushPayload(pushData, settings, userId, getSettings);
  } else {
    await handleMinimalPushPayload(pushData, settings, userId, getSettings);
  }
}

const SET_PUSH_MESSAGE_LISTENER_ACTIVE = 'plugin:notifications|set_push_message_listener_active';

export async function listenForUnifiedPushMessages(getSettings: () => NotificationSettings) {
  const dispatch = createUnifiedPushMessageListener(
    (notification) => handleUnifiedPushPayload(notification, getSettings),
    (error) => {
      unifiedPushLog.error(
        'notification',
        'UnifiedPush payload handling failed',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  );

  const listener = await addPluginListener('notifications', 'push-message', (data: unknown) => {
    const notification = parseUnifiedPushMessage(data);
    if (notification) dispatch(notification);
  });

  try {
    await invoke(SET_PUSH_MESSAGE_LISTENER_ACTIVE, { active: true });
  } catch (error) {
    await listener.unregister().catch(() => {});
    throw error;
  }

  return {
    unregister: async () => {
      try {
        await invoke(SET_PUSH_MESSAGE_LISTENER_ACTIVE, { active: false });
      } finally {
        await listener.unregister();
      }
    },
  };
}
