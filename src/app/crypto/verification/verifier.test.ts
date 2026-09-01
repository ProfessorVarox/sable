import { describe, expect, it, vi } from 'vitest';
import {
  VerificationPhase,
  VerifierEvent,
  type MatrixEvent,
  type ShowQrCodeCallbacks,
  type ShowSasCallbacks,
} from '$types/matrix-sdk';
import { EngineQrVerifier, EngineSasVerifier } from './verifier';

const flow = { userId: '@them:e.org', flowId: '$f' };

describe('EngineSasVerifier', () => {
  it('emits Cancel when the other side cancels', async () => {
    const call = vi.fn<(m: string, a?: Record<string, unknown>) => Promise<unknown>>(
      async () => null
    );
    const verifier = new EngineSasVerifier(call, flow, {}, '@them:e.org');
    const cancelled = vi.fn<(error: Error | MatrixEvent) => void>();
    verifier.on(VerifierEvent.Cancel, cancelled);
    const verifying = verifier.verify();

    verifier.onChange({ isCancelled: true });

    await expect(verifying).rejects.toThrow('Verification cancelled');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(call.mock.calls.filter(([method]) => method === 'sas.cancel')).toHaveLength(0);
  });

  it('does not cancel twice when the engine echoes our own mismatch', async () => {
    const call = vi.fn<(m: string, a?: Record<string, unknown>) => Promise<unknown>>(
      async () => null
    );
    const verifier = new EngineSasVerifier(call, flow, {}, '@them:e.org');
    const cancelled = vi.fn<(error: Error | MatrixEvent) => void>();
    verifier.on(VerifierEvent.Cancel, cancelled);
    const verifying = verifier.verify();

    verifier.onChange({ decimals: [1, 2, 3] });
    verifier.getShowSasCallbacks()?.mismatch();
    verifier.onChange({ isCancelled: true });

    await expect(verifying).rejects.toThrow('The codes did not match');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(call.mock.calls.filter(([method]) => method === 'sas.cancel')).toHaveLength(1);
  });

  it('settles the flow when the user says the codes do not match', async () => {
    const call = vi.fn<(method: string, args: unknown) => Promise<unknown>>(async () => null);
    const verifier = new EngineSasVerifier(call, flow, {}, '@them:e.org');
    const cancelled = vi.fn<(error: Error | MatrixEvent) => void>();
    verifier.on(VerifierEvent.Cancel, cancelled);
    const completion = verifier.verify();

    verifier.onChange({
      emoji: [{ symbol: '🐶', description: 'Dog' }],
      decimals: [1, 2, 3],
    });
    verifier.getShowSasCallbacks()?.mismatch();

    await expect(completion).rejects.toThrow('The codes did not match');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith(
      'sas.cancel',
      expect.objectContaining({ code: 'm.mismatched_sas' })
    );
  });

  it('does not send a second cancel when the user double taps', async () => {
    const call = vi.fn<(method: string, args: unknown) => Promise<unknown>>(async () => null);
    const verifier = new EngineSasVerifier(call, flow, {}, '@them:e.org');
    verifier.verify().catch(() => undefined);

    verifier.onChange({
      emoji: [{ symbol: '🐶', description: 'Dog' }],
      decimals: [1, 2, 3],
    });
    const callbacks = verifier.getShowSasCallbacks();
    callbacks?.cancel();
    callbacks?.cancel();

    expect(call.mock.calls.filter(([method]) => method === 'sas.cancel')).toHaveLength(1);
  });

  // Reading the digits straight after accepting yields nothing: they arrive later.
  it('emits ShowSas when the digits arrive, not when accept is sent', async () => {
    const call = vi.fn<() => Promise<unknown>>(async () => null);
    const verifier = new EngineSasVerifier(call, flow, {}, '@them:e.org');
    const shown = vi.fn<(sas: ShowSasCallbacks) => void>();
    verifier.on(VerifierEvent.ShowSas, shown);

    verifier.onChange({ canBePresented: false });
    expect(shown).not.toHaveBeenCalled();
    expect(verifier.getShowSasCallbacks()).toBeNull();

    verifier.onChange({
      emoji: [{ symbol: '🐶', description: 'Dog' }],
      decimals: [1, 2, 3],
    });

    expect(shown).toHaveBeenCalledOnce();
    expect(verifier.getShowSasCallbacks()?.sas).toEqual({
      emoji: [['🐶', 'Dog']],
      decimal: [1, 2, 3],
    });
  });

  it('emits once even as further snapshots arrive', () => {
    const call = vi.fn<() => Promise<unknown>>(async () => null);
    const verifier = new EngineSasVerifier(call, flow, {}, '@them:e.org');
    const shown = vi.fn<(sas: ShowSasCallbacks) => void>();
    verifier.on(VerifierEvent.ShowSas, shown);

    verifier.onChange({ decimals: [1, 2, 3] });
    verifier.onChange({ decimals: [1, 2, 3], haveWeConfirmed: true });

    expect(shown).toHaveBeenCalledOnce();
  });

  // Resolving early would let the UI close the prompt before the peer confirmed.
  it('resolves verify only once the flow is done', async () => {
    const call = vi.fn<() => Promise<unknown>>(async () => null);
    const verifier = new EngineSasVerifier(call, flow, {}, '@them:e.org');

    let settled = false;
    const verifying = verifier.verify().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    verifier.onChange({ isDone: true });
    await verifying;
    expect(settled).toBe(true);
  });

  it('confirms and cancels through the engine with the right codes', async () => {
    const call = vi.fn<(m: string, a?: Record<string, unknown>) => Promise<unknown>>(
      async () => null
    );
    const verifier = new EngineSasVerifier(call, flow, {}, '@them:e.org');
    verifier.onChange({ decimals: [1, 2, 3] });

    await verifier.getShowSasCallbacks()?.confirm();
    expect(call).toHaveBeenCalledWith('sas.confirm', flow);

    verifier.getShowSasCallbacks()?.mismatch();
    expect(call).toHaveBeenCalledWith('sas.cancel', { ...flow, code: 'm.mismatched_sas' });
    expect(verifier.hasBeenCancelled).toBe(true);
  });

  // js-sdk reports Started throughout SAS; Done is the request's phase, not the verifier's.
  it('reports Started while running, leaving Done to the request', () => {
    const call = vi.fn<() => Promise<unknown>>(async () => null);
    const verifier = new EngineSasVerifier(call, flow, {}, '@them:e.org');

    expect(verifier.verificationPhase).toBe(VerificationPhase.Started);
    verifier.onChange({ isDone: true });
    expect(verifier.verificationPhase).toBe(VerificationPhase.Started);
  });

  it('rejects verify when the flow is cancelled', async () => {
    const call = vi.fn<() => Promise<unknown>>(async () => null);
    const verifier = new EngineSasVerifier(call, flow, {}, '@them:e.org');
    const verifying = verifier.verify();

    verifier.onChange({ isCancelled: true });

    await expect(verifying).rejects.toThrow('Verification cancelled');
    expect(verifier.hasBeenCancelled).toBe(true);
  });
});

describe('EngineQrVerifier', () => {
  it('settles the flow when the user declines the reciprocated code', async () => {
    const call = vi.fn<(m: string, a?: Record<string, unknown>) => Promise<unknown>>(
      async () => null
    );
    const verifier = new EngineQrVerifier(call, flow, {}, '@them:e.org');
    const verifying = verifier.verify();

    verifier.onChange({ hasBeenScanned: true });
    verifier.getReciprocateQrCodeCallbacks()?.cancel();

    await expect(verifying).rejects.toThrow('Verification cancelled');
    expect(call).toHaveBeenCalledWith('qr.cancel', expect.objectContaining({ code: 'm.user' }));
  });

  it('offers reciprocate callbacks only once our code has been scanned', () => {
    const call = vi.fn<() => Promise<unknown>>(async () => null);
    const verifier = new EngineQrVerifier(call, flow, {}, '@them:e.org');
    const shown = vi.fn<(qr: ShowQrCodeCallbacks) => void>();
    verifier.on(VerifierEvent.ShowReciprocateQr, shown);

    verifier.onChange({ hasBeenScanned: false });
    expect(verifier.getReciprocateQrCodeCallbacks()).toBeNull();

    verifier.onChange({ hasBeenScanned: true });
    expect(shown).toHaveBeenCalledOnce();
    expect(verifier.getReciprocateQrCodeCallbacks()).not.toBeNull();
  });
});
