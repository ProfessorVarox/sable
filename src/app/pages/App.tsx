import { lazy, Suspense, useCallback, useMemo, useRef } from 'react';
import { Provider as JotaiProvider } from 'jotai';
import { createStore } from 'jotai/vanilla';
import { OverlayContainerProvider, PopOutContainerProvider, TooltipContainerProvider } from 'folds';
import { RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';

import { ClientConfigLoader } from '$components/ClientConfigLoader';
import type { ClientConfig } from '$hooks/useClientConfig';
import { ClientConfigProvider } from '$hooks/useClientConfig';
import { setMatrixToBase } from '$plugins/matrix-to';
import type { ScreenSize } from '$hooks/useScreenSize';
import { ScreenSizeProvider, useScreenSize } from '$hooks/useScreenSize';
import { useCompositionEndTracking } from '$hooks/useComposingCheck';
import { ErrorPage } from '$components/DefaultErrorPage';
import { FeatureCheck } from './FeatureCheck';
import { createRouter } from './Router';
import { isReactQueryDevtoolsEnabled } from './reactQueryDevtoolsGate';
import { bootstrapSettingsStore } from '$state/settings';

const queryClient = new QueryClient();
const ReactQueryDevtools = lazy(async () => {
  const { ReactQueryDevtools: Devtools } = await import('@tanstack/react-query-devtools');

  return { default: Devtools };
});

type BootstrappedAppShellProps = {
  clientConfig: ClientConfig;
  screenSize: ScreenSize;
};

function BootstrappedAppShell({ clientConfig, screenSize }: BootstrappedAppShellProps) {
  const jotaiStoreRef = useRef<ReturnType<typeof createStore>>();
  if (!jotaiStoreRef.current) {
    jotaiStoreRef.current = createStore();
    bootstrapSettingsStore(jotaiStoreRef.current, clientConfig.settingsDefaults);
  }
  const router = useMemo(() => createRouter(clientConfig, screenSize), [clientConfig, screenSize]);
  const reactQueryDevtoolsEnabled = isReactQueryDevtoolsEnabled();

  return (
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={jotaiStoreRef.current}>
        <RouterProvider router={router} />
      </JotaiProvider>
      {reactQueryDevtoolsEnabled && (
        <Suspense fallback={null}>
          <ReactQueryDevtools initialIsOpen={false} />
        </Suspense>
      )}
    </QueryClientProvider>
  );
}

function renderSentryErrorFallback({ error, eventId }: { error: unknown; eventId: string | null }) {
  return (
    <ErrorPage
      error={error instanceof Error ? error : new Error(String(error))}
      eventId={eventId || undefined}
    />
  );
}

function App() {
  const screenSize = useScreenSize();
  useCompositionEndTracking();
  const portalContainer = document.getElementById('portalContainer') ?? undefined;

  const renderConfiguredApp = useCallback(
    (clientConfig: ClientConfig) => {
      setMatrixToBase(clientConfig.matrixToBaseUrl);
      return (
        <ClientConfigProvider value={clientConfig}>
          <BootstrappedAppShell clientConfig={clientConfig} screenSize={screenSize} />
        </ClientConfigProvider>
      );
    },
    [screenSize]
  );

  return (
    <Sentry.ErrorBoundary fallback={renderSentryErrorFallback}>
      <TooltipContainerProvider value={portalContainer}>
        <PopOutContainerProvider value={portalContainer}>
          <OverlayContainerProvider value={portalContainer}>
            <ScreenSizeProvider value={screenSize}>
              <FeatureCheck>
                <ClientConfigLoader>{renderConfiguredApp}</ClientConfigLoader>
              </FeatureCheck>
            </ScreenSizeProvider>
          </OverlayContainerProvider>
        </PopOutContainerProvider>
      </TooltipContainerProvider>
    </Sentry.ErrorBoundary>
  );
}

export default App;
