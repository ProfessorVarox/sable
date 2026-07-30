import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_BAR_REFRESH_EVENT, SystemBarShell } from './SystemBarShell';

const { mockIsTauri, mockOsType } = vi.hoisted(() => ({
  mockIsTauri: vi.fn<() => boolean>(),
  mockOsType: vi.fn<() => string>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn<() => Promise<void>>(),
  isTauri: mockIsTauri,
}));

vi.mock('@tauri-apps/plugin-os', () => ({
  type: mockOsType,
}));

describe('SystemBarShell', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does not observe document mutations outside mobile Tauri', () => {
    mockIsTauri.mockReturnValue(false);
    const mutationObserver = vi.fn<() => void>();
    vi.stubGlobal('MutationObserver', mutationObserver);

    const { container } = render(
      <SystemBarShell onPortalContainerChange={vi.fn<(node: HTMLDivElement | null) => void>()}>
        <div>Content</div>
      </SystemBarShell>
    );

    expect(mockOsType).not.toHaveBeenCalled();
    expect(mutationObserver).not.toHaveBeenCalled();
    expect(container.querySelector('[data-system-bar-position="top"]')).toHaveStyle({
      height: 'var(--safe-area-inset-top, env(safe-area-inset-top, 0px))',
    });
    expect(container.querySelector('[data-system-bar-position="bottom"]')).not.toBeInTheDocument();
  });

  it('schedules an immediate rAF and a trailing 120ms timeout on mutation', () => {
    vi.useFakeTimers();
    mockIsTauri.mockReturnValue(true);
    mockOsType.mockReturnValue('android');

    let rAFCount = 0;
    let rAFId = 1;
    vi.stubGlobal('cancelAnimationFrame', vi.fn<() => void>());
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn<() => number>(() => {
        rAFId += 1;
        rAFCount += 1;
        return rAFId;
      })
    );

    let mutationCallback: MutationCallback | undefined;
    class FakeMutationObserver {
      observe = vi.fn<(target: Node, options?: MutationObserverInit) => void>();
      disconnect = vi.fn<() => void>();

      constructor(callback: MutationCallback) {
        mutationCallback = callback;
      }
    }
    vi.stubGlobal('MutationObserver', FakeMutationObserver);

    render(
      <SystemBarShell onPortalContainerChange={vi.fn<(node: HTMLDivElement | null) => void>()}>
        <div>Content</div>
      </SystemBarShell>
    );

    const rAFAfterMount = rAFCount;

    expect(mutationCallback).toBeDefined();
    mutationCallback!([], {} as MutationObserver);

    expect(rAFCount).toBe(rAFAfterMount + 1);
    vi.advanceTimersByTime(119);
    expect(rAFCount).toBe(rAFAfterMount + 1);
    vi.advanceTimersByTime(1);

    expect(rAFCount).toBe(rAFAfterMount + 2);
  });

  it('samples synchronously on a custom refresh event', () => {
    vi.useFakeTimers();
    mockIsTauri.mockReturnValue(true);
    mockOsType.mockReturnValue('android');

    let rAFId = 1;
    const requestAnimationFrameMock = vi.fn<() => number>(() => {
      rAFId += 1;
      return rAFId;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn<() => void>());
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);
    const elementFromPoint = vi.fn<(x: number, y: number) => Element | null>(() => null);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: elementFromPoint,
    });

    class FakeMutationObserver {
      observe = vi.fn<(target: Node, options?: MutationObserverInit) => void>();
      disconnect = vi.fn<() => void>();
    }
    vi.stubGlobal('MutationObserver', FakeMutationObserver);

    render(
      <SystemBarShell onPortalContainerChange={vi.fn<(node: HTMLDivElement | null) => void>()}>
        <div>Content</div>
      </SystemBarShell>
    );

    const rAFAfterMount = requestAnimationFrameMock.mock.calls.length;
    window.dispatchEvent(new Event(SYSTEM_BAR_REFRESH_EVENT));

    expect(elementFromPoint).toHaveBeenCalledTimes(2);
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(rAFAfterMount);
  });
});
