export type UnifiedPushMessageHandler = (data: Record<string, unknown>) => Promise<void>;
export type UnifiedPushMessageErrorHandler = (error: unknown) => void;

export function createUnifiedPushMessageListener(
  handler: UnifiedPushMessageHandler,
  onError: UnifiedPushMessageErrorHandler
) {
  return (data: Record<string, unknown>) => {
    handler(data).catch(onError);
  };
}

export function parseUnifiedPushMessage(raw: unknown): Record<string, unknown> | null {
  const message = (raw as { message?: unknown })?.message;
  if (typeof message !== 'string') return null;

  let payload: unknown;
  try {
    payload = JSON.parse(message);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;

  let notification = payload.notification === undefined ? payload : payload.notification;
  if (typeof notification === 'string') {
    try {
      notification = JSON.parse(notification);
    } catch {
      return null;
    }
  }
  if (!isRecord(notification)) return null;

  const recipients = new Set<string>();
  const addRecipient = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) recipients.add(value.trim());
  };
  addRecipient(payload.user_id);
  addRecipient(notification.user_id);
  if (Array.isArray(notification.devices)) {
    for (const device of notification.devices) {
      if (!isRecord(device) || !isRecord(device.data)) continue;
      addRecipient(device.data.user_id);
      if (isRecord(device.data.default_payload)) {
        addRecipient(device.data.default_payload.user_id);
      }
    }
  }
  if (recipients.size > 1) return null;
  const [userId] = recipients;
  return userId ? { ...notification, user_id: userId } : notification;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
