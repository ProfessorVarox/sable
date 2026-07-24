import React, { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Box } from 'folds';
import * as css from '$features/room/message/styles.css';
import { useDismissOnBack } from '$utils/androidBack';
import { getMobileSheetTiming, useMobileSheetAnimation } from './mobileSheetAnimation';
import * as animationCss from './mobileSheetAnimation.css';

interface MobileSwipeDownModalProps {
  children: (
    dragHandle: React.ReactNode,
    dragHandlers: {
      onTouchStart: (e: React.TouchEvent) => void;
      onTouchMove: (e: React.TouchEvent) => void;
      onTouchEnd: () => void;
    }
  ) => React.ReactNode;
  requestClose: () => void;
}

export function MobileSwipeDownModal({ children, requestClose }: MobileSwipeDownModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);
  const touchYDiff = useRef(0);
  const startTime = useRef(0);
  const [mounted, setMounted] = useState(false);
  const resetAnimationRef = useRef<Animation>();
  const { shouldReduceMotion } = useMobileSheetAnimation();

  useEffect(() => {
    setMounted(true);
  }, []);

  // Android back closes the overlay instead of navigating away.
  useDismissOnBack(requestClose);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0]?.clientY ?? null;
    startTime.current = Date.now();
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current === null || !e.touches[0]) return;
    const touchY = e.touches[0].clientY;
    const diff = touchY - touchStartY.current;

    // Only allow pulling down
    if (diff > 0) {
      touchYDiff.current = diff;
      resetAnimationRef.current?.cancel();
      containerRef.current?.getAnimations().forEach((animation) => animation.cancel());
      if (containerRef.current) {
        containerRef.current.style.transform = `translate3d(0, ${diff}px, 0)`;
      }
    }
  };

  const handleTouchEnd = () => {
    const endTime = Date.now();
    if (
      touchYDiff.current > 100 ||
      (endTime - startTime.current < 600 && touchYDiff.current > 20)
    ) {
      requestClose();
    } else {
      const currentOffset = touchYDiff.current;
      touchYDiff.current = 0;
      if (containerRef.current) {
        const container = containerRef.current;
        resetAnimationRef.current = container.animate(
          [
            { transform: `translate3d(0, ${currentOffset}px, 0)` },
            { transform: 'translate3d(0, 0, 0)' },
          ],
          getMobileSheetTiming(shouldReduceMotion)
        );
        resetAnimationRef.current.addEventListener(
          'finish',
          () => {
            container.style.transform = '';
          },
          { once: true }
        );
      }
    }
    touchStartY.current = null;
  };

  const dragHandlers = {
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd,
  };

  const dragHandleJSX = (
    <div className={css.MessageMobileDragHandle} {...dragHandlers}>
      <div className={css.MessageMobileDragIndicator} />
    </div>
  );

  if (!mounted) return null;

  return createPortal(
    <Box
      className={css.MessageMobileOptionsWrapped}
      data-gestures="ignore"
      onClick={requestClose}
      onTouchStart={(e: React.TouchEvent) => e.stopPropagation()}
      onTouchMove={(e: React.TouchEvent) => e.stopPropagation()}
      onTouchEnd={(e: React.TouchEvent) => e.stopPropagation()}
    >
      <Box
        ref={containerRef}
        className={`${css.MessageMobileOptionsContainer} ${animationCss.SheetEntrance}`}
        style={shouldReduceMotion ? { animation: 'none' } : undefined}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {children(dragHandleJSX, dragHandlers)}
      </Box>
    </Box>,
    document.body
  );
}
