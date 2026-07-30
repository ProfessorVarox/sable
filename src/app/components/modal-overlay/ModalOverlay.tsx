import { useRef } from 'react';
import type { ComponentProps, MutableRefObject, ReactNode } from 'react';
import FocusTrap from 'focus-trap-react';
import { Box, Modal, Overlay, OverlayBackdrop, OverlayCenter } from 'folds';
import { ScreenSize, useScreenSizeOptionally } from '$hooks/useScreenSize';
import { stopPropagation } from '$utils/keyboard';
import { useDismissOnBack } from '$utils/androidBack';
import { MobileSwipeDownModal } from '$components/MobileSwipeDownModal';
import * as messageCss from '$features/room/message/styles.css';

type FocusTrapOptions = ComponentProps<typeof FocusTrap>['focusTrapOptions'];
type ModalSize = '300' | '400' | '500';

type ModalOverlayProps = {
  open?: boolean;
  requestClose: () => void;
  /** Set false for overlays that must be dismissed deliberately, not by a stray click. */
  dismissOnClickOutside?: boolean;
  /** `centred` keeps the desktop-style dialog on phones.
   *  `fullscreen` drops the centred modal and fills the viewport.
   *  `sheet` rises as a bottom sheet with a swipe-down-to-dismiss handle. */
  mobile?: 'centred' | 'fullscreen' | 'sheet';
  /** When set, ModalOverlay owns the `<Modal>` chrome. Callers passing `size`
   *  must not wrap children in `<Modal>` themselves. */
  size?: ModalSize;
  /** The modal element, used as the focus fallback and as the fullscreen wrapper. */
  contentRef?: MutableRefObject<HTMLDivElement | null>;
  /** Set false for flows that Escape must not abort, such as device verification. */
  escapeDeactivates?: FocusTrapOptions['escapeDeactivates'];
  children: ReactNode;
};

export function ModalOverlay({
  open = true,
  requestClose,
  dismissOnClickOutside = true,
  mobile = 'centred',
  size,
  contentRef,
  escapeDeactivates = stopPropagation,
  children,
}: ModalOverlayProps) {
  // Null outside a provider, where desktop is the safe assumption.
  const isMobile = useScreenSizeOptionally() === ScreenSize.Mobile;
  const ownedModalRef = useRef<HTMLDivElement | null>(null);

  const sheet = isMobile && mobile === 'sheet';

  // Android back closes the overlay instead of navigating away. The sheet registers
  // its own handler, and a child's runs first, so registering here too would skip
  // the sheet's exit animation.
  useDismissOnBack(requestClose, open && !sheet);

  if (open && isMobile && mobile === 'fullscreen') {
    return (
      <Overlay open>
        <FocusTrap
          focusTrapOptions={{
            initialFocus: false,
            escapeDeactivates,
            onDeactivate: requestClose,
          }}
        >
          <div
            ref={contentRef}
            tabIndex={-1}
            style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}
          >
            {children}
          </div>
        </FocusTrap>
      </Overlay>
    );
  }

  if (open && sheet) {
    const focusTrapOptions = {
      initialFocus: false,
      fallbackFocus: () => document.body,
      onDeactivate: requestClose,
      clickOutsideDeactivates: dismissOnClickOutside,
      escapeDeactivates,
    };
    return (
      <MobileSwipeDownModal requestClose={requestClose}>
        {() => (
          <FocusTrap focusTrapOptions={focusTrapOptions}>
            <div role="dialog" aria-modal="true" className={messageCss.MessageOptionsSheetMenu}>
              <Box direction="Column">{children}</Box>
            </div>
          </FocusTrap>
        )}
      </MobileSwipeDownModal>
    );
  }

  return (
    <Overlay open={open} backdrop={<OverlayBackdrop />}>
      <OverlayCenter>
        <FocusTrap
          focusTrapOptions={{
            initialFocus: false,
            fallbackFocus: () =>
              (size ? ownedModalRef.current : contentRef?.current) ?? document.body,
            clickOutsideDeactivates: dismissOnClickOutside,
            onDeactivate: requestClose,
            escapeDeactivates,
          }}
        >
          {size ? (
            <Modal ref={ownedModalRef} tabIndex={-1} size={size} variant="Background">
              {children}
            </Modal>
          ) : (
            children
          )}
        </FocusTrap>
      </OverlayCenter>
    </Overlay>
  );
}
