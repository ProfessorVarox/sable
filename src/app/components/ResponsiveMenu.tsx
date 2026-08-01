import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import type { RectCords } from 'folds';
import { Box, Overlay, OverlayBackdrop, OverlayCenter, PopOut } from 'folds';
import FocusTrap from 'focus-trap-react';
import { ScreenSize, useScreenSizeOptionally } from '$hooks/useScreenSize';
import { stopPropagation } from '$utils/keyboard';
import { useDismissOnBack } from '$utils/androidBack';
import { MobileSheetFocusTrap, MobileSwipeDownModal } from './MobileSwipeDownModal';
import * as css from './ResponsiveMenu.css';

type ComponentPosition = 'Top' | 'Right' | 'Bottom' | 'Left';
type ComponentAlign = 'Start' | 'Center' | 'End';
type FocusTrapOptions = ComponentProps<typeof FocusTrap>['focusTrapOptions'];

type ResponsiveMenuProps = {
  anchor: RectCords | undefined;
  requestClose: () => void;
  menu: ReactNode;
  /** The element the menu hangs off on desktop. */
  children?: ReactNode;
  position?: ComponentPosition;
  align?: ComponentAlign;
  offset?: number;
  alignOffset?: number;
  /** Set true for menus whose trigger should regain focus when they close. */
  returnFocusOnDeactivate?: boolean;
  /** `both` also maps Left/Right, for menus laid out horizontally. */
  arrowNavigation?: 'vertical' | 'both';
  /** How the menu shows on mobile: a bottom sheet, or a centred dialog for
   *  option pickers, which a sheet makes look like an action menu. */
  mobile?: 'sheet' | 'dialog';
  surfaceColor?: string;
};

function MenuDialog({
  requestClose,
  focusTrapOptions,
  children,
}: {
  requestClose: () => void;
  focusTrapOptions: FocusTrapOptions;
  children: ReactNode;
}) {
  // Android back closes the dialog instead of navigating away.
  useDismissOnBack(requestClose);

  return (
    <Overlay open backdrop={<OverlayBackdrop />}>
      <OverlayCenter>
        <FocusTrap focusTrapOptions={focusTrapOptions}>
          <Box direction="Column" role="dialog" aria-modal="true" className={css.DialogContent}>
            {children}
          </Box>
        </FocusTrap>
      </OverlayCenter>
    </Overlay>
  );
}

/**
 * A menu that hangs off its trigger on desktop and rises as a bottom sheet on
 * mobile, where a popout anchored to a tiny target is hard to hit and easy to
 * dismiss by accident.
 */
export function ResponsiveMenu({
  anchor,
  requestClose,
  menu,
  children,
  position = 'Bottom',
  align = 'End',
  offset,
  alignOffset,
  returnFocusOnDeactivate = false,
  arrowNavigation = 'vertical',
  mobile = 'sheet',
  surfaceColor,
}: ResponsiveMenuProps) {
  // Null outside a provider, where desktop is the safe assumption.
  const isMobile = useScreenSizeOptionally() === ScreenSize.Mobile;

  const isKeyForward = (evt: KeyboardEvent) =>
    evt.key === 'ArrowDown' || (arrowNavigation === 'both' && evt.key === 'ArrowRight');
  const isKeyBackward = (evt: KeyboardEvent) =>
    evt.key === 'ArrowUp' || (arrowNavigation === 'both' && evt.key === 'ArrowLeft');

  const focusTrapOptions = {
    initialFocus: false,
    fallbackFocus: () => document.body,
    returnFocusOnDeactivate,
    onDeactivate: requestClose,
    clickOutsideDeactivates: !isMobile,
    allowOutsideClick: isMobile,
    isKeyForward,
    isKeyBackward,
    escapeDeactivates: stopPropagation,
  };

  if (isMobile) {
    const sheetStyle: CSSProperties | undefined = surfaceColor
      ? { backgroundColor: surfaceColor }
      : undefined;

    return (
      <>
        {children}
        {anchor && mobile === 'dialog' && (
          <MenuDialog requestClose={requestClose} focusTrapOptions={focusTrapOptions}>
            {menu}
          </MenuDialog>
        )}
        {anchor && mobile === 'sheet' && (
          <MobileSwipeDownModal requestClose={requestClose} sheetStyle={sheetStyle}>
            {() => (
              <MobileSheetFocusTrap
                focusTrapOptions={{
                  ...focusTrapOptions,
                  // The backdrop owns tap-to-dismiss. Left to focus-trap, the
                  // mousedown synthesised when a long press is released lands on
                  // the backdrop and reads as a click outside.
                  clickOutsideDeactivates: false,
                  allowOutsideClick: true,
                }}
              >
                <Box
                  direction="Column"
                  role="dialog"
                  aria-modal="true"
                  className={css.SheetContent}
                >
                  {menu}
                </Box>
              </MobileSheetFocusTrap>
            )}
          </MobileSwipeDownModal>
        )}
      </>
    );
  }

  return (
    <PopOut
      aria-expanded={!!anchor}
      anchor={anchor}
      position={position}
      align={align}
      offset={offset}
      alignOffset={alignOffset}
      content={
        // Gated so a call site that builds its menu inline does that work on open,
        // not on every render of the trigger.
        anchor ? <FocusTrap focusTrapOptions={focusTrapOptions}>{menu}</FocusTrap> : null
      }
    >
      {children}
    </PopOut>
  );
}
