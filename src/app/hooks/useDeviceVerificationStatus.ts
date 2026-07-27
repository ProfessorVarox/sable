import { useEffect } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CryptoApi, type CryptoEventHandlerMap, CryptoEvent } from '$types/matrix-sdk';
import { verifiedDevice } from '$utils/matrix-crypto';
import { useMatrixClient } from './useMatrixClient';

export const useCrossSigningKeysChange = (
  onChange: CryptoEventHandlerMap[CryptoEvent.KeysChanged]
) => {
  const mx = useMatrixClient();
  useEffect(() => {
    mx.on(CryptoEvent.KeysChanged, onChange);
    return () => {
      mx.removeListener(CryptoEvent.KeysChanged, onChange);
    };
  }, [mx, onChange]);
};

// onUserIdentityUpdated only emits KeysChanged for our own identity, so another user's
// cross-signing status changes are observable through this event alone.
export const useUserTrustStatusChange = (
  onChange: CryptoEventHandlerMap[CryptoEvent.UserTrustStatusChanged]
) => {
  const mx = useMatrixClient();
  useEffect(() => {
    mx.on(CryptoEvent.UserTrustStatusChanged, onChange);
    return () => {
      mx.removeListener(CryptoEvent.UserTrustStatusChanged, onChange);
    };
  }, [mx, onChange]);
};

export enum VerificationStatus {
  Unknown,
  Unverified,
  Verified,
  Unsupported,
}

const DEVICE_VERIFICATION_QUERY_KEY = 'device-verification';

const cryptoIds = new WeakMap<CryptoApi, string>();
let cryptoIdCounter = 0;

const getCryptoId = (crypto: CryptoApi | undefined): string => {
  if (!crypto) return 'none';
  let id = cryptoIds.get(crypto);
  if (!id) {
    id = `crypto_${++cryptoIdCounter}`;
    cryptoIds.set(crypto, id);
  }
  return id;
};

// Cache per device so repeated consumers share one verification result.
// Event-driven invalidation refreshes the cache when device or trust data may have changed.
const deviceVerificationQuery = (
  crypto: CryptoApi | undefined,
  userId: string,
  deviceId: string | undefined
) => ({
  queryKey: [DEVICE_VERIFICATION_QUERY_KEY, userId, deviceId ?? '', getCryptoId(crypto)],
  queryFn: async () => {
    if (!crypto || !deviceId) return null;
    return verifiedDevice(crypto, userId, deviceId);
  },
  enabled: Boolean(crypto) && Boolean(deviceId),
  staleTime: Infinity,
  // Crypto listeners are shared only while a consumer is mounted. Refresh on
  // remount so changes that happened while the UI was closed cannot stay hidden
  // behind an indefinitely fresh inactive query.
  refetchOnMount: 'always' as const,
});

type SubscriptionState = {
  refCount: number;
  cleanup: () => void;
};

const clientSubscriptions = new WeakMap<ReturnType<typeof useMatrixClient>, SubscriptionState>();

const useInvalidateDeviceVerification = (crypto: CryptoApi | undefined): void => {
  const mx = useMatrixClient();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!crypto) return undefined;

    let sub = clientSubscriptions.get(mx);
    if (!sub) {
      const onDevicesUpdated: CryptoEventHandlerMap[CryptoEvent.DevicesUpdated] = (userIds) => {
        for (const uid of userIds) {
          queryClient.invalidateQueries({ queryKey: [DEVICE_VERIFICATION_QUERY_KEY, uid] });
        }
      };
      const onKeysChanged: CryptoEventHandlerMap[CryptoEvent.KeysChanged] = () => {
        queryClient.invalidateQueries({ queryKey: [DEVICE_VERIFICATION_QUERY_KEY] });
      };
      const onUserTrustStatusChanged: CryptoEventHandlerMap[CryptoEvent.UserTrustStatusChanged] = (
        changedUserId
      ) => {
        queryClient.invalidateQueries({
          queryKey: [DEVICE_VERIFICATION_QUERY_KEY, changedUserId],
        });
      };

      mx.on(CryptoEvent.DevicesUpdated, onDevicesUpdated);
      mx.on(CryptoEvent.KeysChanged, onKeysChanged);
      mx.on(CryptoEvent.UserTrustStatusChanged, onUserTrustStatusChanged);

      sub = {
        refCount: 0,
        cleanup: () => {
          mx.removeListener(CryptoEvent.DevicesUpdated, onDevicesUpdated);
          mx.removeListener(CryptoEvent.KeysChanged, onKeysChanged);
          mx.removeListener(CryptoEvent.UserTrustStatusChanged, onUserTrustStatusChanged);
        },
      };
      clientSubscriptions.set(mx, sub);
    }

    sub.refCount++;

    return () => {
      sub!.refCount--;
      if (sub!.refCount === 0) {
        sub!.cleanup();
        clientSubscriptions.delete(mx);
      }
    };
  }, [mx, crypto, queryClient]);
};

const toVerificationStatus = (verified: boolean | null | undefined): VerificationStatus => {
  if (verified === undefined) return VerificationStatus.Unknown;
  if (verified === null) return VerificationStatus.Unsupported;
  return verified ? VerificationStatus.Verified : VerificationStatus.Unverified;
};

export const useDeviceVerificationStatus = (
  crypto: CryptoApi | undefined,
  userId: string,
  deviceId: string | undefined
): VerificationStatus => {
  useInvalidateDeviceVerification(crypto);

  const { data } = useQuery(deviceVerificationQuery(crypto, userId, deviceId));

  return toVerificationStatus(data);
};

export const useUnverifiedDeviceCount = (
  crypto: CryptoApi | undefined,
  userId: string,
  devices: string[]
): number | undefined => {
  useInvalidateDeviceVerification(crypto);

  return useQueries({
    queries: devices.map((deviceId) => deviceVerificationQuery(crypto, userId, deviceId)),
    combine: (results) => {
      if (!crypto) return 0;
      if (results.some((result) => result.isPending)) return undefined;
      return results.filter((result) => result.data === false).length;
    },
  });
};
