import { useCallback } from 'react';
import type { CryptoBackend, MatrixClient, MatrixEvent } from '$types/matrix-sdk';
import { useAccountDataCallback } from './useAccountDataCallback';

export const useCrossSigningResetDetect = (mx: MatrixClient | undefined) => {
  const onAccountData = useCallback(
    (evt: MatrixEvent) => {
      if (!mx || !evt.getType().startsWith('m.cross_signing.')) return;
      const crypto = mx.getCrypto() as CryptoBackend | undefined;
      if (!crypto) return;
      void crypto.processDeviceLists({ changed: [mx.getSafeUserId()] });
    },
    [mx]
  );

  useAccountDataCallback(mx, onAccountData);
};
