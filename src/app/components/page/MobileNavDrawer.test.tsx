import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { MobileNavDrawer } from './MobileNavDrawer';

vi.mock('$state/hooks/settings', () => ({
  useSetting: () => [true, vi.fn<() => void>()],
}));

vi.mock('./PersistentRoomHost', () => ({
  PersistentRoomHost: () => <div data-testid="persistent-room-host" />,
}));

beforeAll(() => {
  window.matchMedia =
    window.matchMedia ??
    ((query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList);
});

const renderDrawer = () =>
  render(
    <MemoryRouter initialEntries={['/home']}>
      <MobileNavDrawer nav={<div>nav</div>}>
        <div>content</div>
      </MobileNavDrawer>
    </MemoryRouter>
  );

describe('MobileNavDrawer', () => {
  // The panels sit side by side in a track twice the viewport wide, moved by transform.
  // `hidden` leaves a scrollport that focus or scrollIntoView scrolls a full panel width,
  // stacking on top of the transform and stranding the active panel off frame.
  it('clips the viewport instead of hiding overflow, so it can never be scrolled', () => {
    renderDrawer();

    const viewport = screen.getByTestId('mobile-nav-drawer-viewport');

    expect(viewport.style.overflow).toBe('clip');
    expect(viewport.style.overflow).not.toBe('hidden');
  });
});
