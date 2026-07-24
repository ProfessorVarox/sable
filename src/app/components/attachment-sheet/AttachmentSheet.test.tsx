import { type PointerEventHandler, useRef, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentSheet } from './AttachmentSheet';

vi.mock('$state/hooks/settings', () => ({
  useSetting: () => [false, vi.fn<() => void>()],
}));

vi.mock('$utils/user-agent', () => ({
  mobileOrTablet: () => false,
}));

const callbacks = () => ({
  onClose: vi.fn<() => void>(),
  onPickPhotos: vi.fn<() => void>(),
  onPickFile: vi.fn<() => void>(),
  onPickPoll: vi.fn<() => void>(),
  onPickLocation: vi.fn<() => void>(),
});

type Handlers = ReturnType<typeof callbacks>;

function AttachmentSheetHarness({
  handlers,
  onPointerDown,
}: {
  handlers: Handlers;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLElement>(null);

  return (
    <div onPointerDown={onPointerDown}>
      <button type="button" onClick={() => setOpen(true)}>
        Open attachments
      </button>
      <section ref={containerRef} data-testid="chat-pane" />
      <AttachmentSheet
        open={open}
        containerRef={containerRef}
        {...handlers}
        onClose={() => {
          handlers.onClose();
          setOpen(false);
        }}
      />
    </div>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AttachmentSheet', () => {
  it('portals into a host whose ref was attached while the sheet was closed', () => {
    const handlers = callbacks();
    render(<AttachmentSheetHarness handlers={handlers} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open attachments' }));

    const chatPane = screen.getByTestId('chat-pane');
    const dialog = screen.getByRole('dialog', { name: 'Share' });
    const backdrop = dialog.previousElementSibling;

    expect(chatPane).toContainElement(dialog);
    expect(dialog.parentElement).toBe(chatPane);
    expect(backdrop).not.toBeNull();
    expect(backdrop?.parentElement).toBe(chatPane);
    expect(dialog.parentElement).not.toBe(document.body);
  });

  it('does not render the dialog without a portal target', () => {
    const { container } = render(
      <AttachmentSheet open containerRef={{ current: null }} {...callbacks()} />
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('delegates Photos selection without directly closing', () => {
    const handlers = callbacks();
    render(<AttachmentSheetHarness handlers={handlers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open attachments' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open photo gallery' }));

    expect(handlers.onPickPhotos).toHaveBeenCalledOnce();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it('shields room pointer gestures from icon descendants', () => {
    const handlers = callbacks();
    const onPointerDown = vi.fn<PointerEventHandler<HTMLDivElement>>();
    render(<AttachmentSheetHarness handlers={handlers} onPointerDown={onPointerDown} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open attachments' }));
    const iconPath = screen
      .getByRole('button', { name: 'Open photo gallery' })
      .querySelector('path');

    expect(iconPath).not.toBeNull();
    fireEvent.pointerDown(iconPath!);
    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it('does not move focus on open, closes once on Escape, and restores the opener', async () => {
    const handlers = callbacks();
    render(<AttachmentSheetHarness handlers={handlers} />);
    const opener = screen.getByRole('button', { name: 'Open attachments' });

    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Share' })).not.toHaveFocus();
    expect(opener).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });

    expect(handlers.onClose).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    });
  });
});
