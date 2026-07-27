import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import type { Update } from '@tauri-apps/plugin-updater';
import { isDesktopTauri } from '$utils/platform';
import { autoUpdateCheckAtom } from '$state/autoUpdateCheck';
import { createLogger } from '$utils/debug';
import { hasCustomDesktopTitlebar } from '$utils/tauriTitlebar';
import { useDesktopSetting } from '$state/hooks/desktopSettings';
import { ArrowUp } from '$components/icons/phosphor';
import { useRegisterGlobalBanner, type GlobalBanner } from '$state/globalBanners';
import {
  updatePhaseAtom,
  updateBannerVisibleAtom,
  triggerUpdateCheckAtom,
  desktopUpdateLastCheckedAtom,
  fakeDesktopUpdate,
} from '$state/desktopUpdate';

const log = createLogger('DesktopUpdater');
const UPDATE_POLL_INTERVAL_MS = 300_000; // 5 minutes

export function DesktopUpdater() {
  const autoUpdateCheck = useAtomValue(autoUpdateCheckAtom);
  const triggerCount = useAtomValue(triggerUpdateCheckAtom);
  const setPhase = useSetAtom(updatePhaseAtom);
  const [bannerVisible, setBannerVisible] = useAtom(updateBannerVisibleAtom);
  const setLastChecked = useSetAtom(desktopUpdateLastCheckedAtom);
  const [updateInfo, setUpdateInfo] = useState<Update | null>(null);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [useCustomTitleBar] = useDesktopSetting('useCustomTitleBar');
  const hasUpdateRef = useRef(false);

  useEffect(() => {
    if (!isDesktopTauri()) return undefined;
    if (triggerCount === 0 && !autoUpdateCheck && !fakeDesktopUpdate()) return undefined;

    let mounted = true;

    setPhase({ type: 'checking' });

    async function run() {
      try {
        if (fakeDesktopUpdate()) {
          log.log('Fake update: simulating download');
          setUpdateInfo({ version: '9.9.9', body: 'Fake changelog for testing.' } as Update);
          setPhase({ type: 'downloading', progress: 0 });
          for (let pct = 0; pct <= 100; pct += 2) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 40));
            if (!mounted) return;
            setPhase({ type: 'downloading', progress: pct });
          }
          if (!mounted) return;
          setIsDownloaded(true);
          setPhase({ type: 'ready', version: '9.9.9' });
          setLastChecked(new Date().toISOString());
          if (!hasCustomDesktopTitlebar(useCustomTitleBar)) setBannerVisible(true);
          return;
        }

        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (!mounted) return;

        if (!update) {
          if (!hasUpdateRef.current) {
            setPhase({ type: 'idle' });
          }
          setLastChecked(new Date().toISOString());
          return;
        }

        log.log(`Desktop update ${update.version} available, downloading...`);
        setUpdateInfo(update);
        setIsInstalled(false);
        setDismissed(false);
        hasUpdateRef.current = true;
        setPhase({ type: 'downloading', progress: 0 });

        let downloadedBytes = 0;
        let contentLength = 0;
        await update.download((event) => {
          if (event.event === 'Started') {
            contentLength = event.data.contentLength ?? 0;
          } else if (event.event === 'Progress') {
            downloadedBytes += event.data.chunkLength;
            const pct = contentLength > 0 ? Math.round((downloadedBytes / contentLength) * 100) : 0;
            setPhase({ type: 'downloading', progress: Math.min(pct, 100) });
          }
        });

        if (!mounted) return;
        log.log(`Update ${update.version} downloaded`);
        setIsDownloaded(true);
        setPhase({ type: 'ready', version: update.version });
        setLastChecked(new Date().toISOString());
        if (!hasCustomDesktopTitlebar(useCustomTitleBar)) setBannerVisible(true);
      } catch (err) {
        log.error('Desktop update check failed', err);
        if (mounted) {
          if (!hasUpdateRef.current) {
            setPhase({ type: 'idle' });
          }
          setLastChecked(new Date().toISOString());
        }
      }
    }

    run();

    if (autoUpdateCheck) {
      const interval = setInterval(run, UPDATE_POLL_INTERVAL_MS);
      return () => {
        mounted = false;
        clearInterval(interval);
      };
    }

    return () => {
      mounted = false;
    };
  }, [
    autoUpdateCheck,
    triggerCount,
    setPhase,
    setBannerVisible,
    setLastChecked,
    useCustomTitleBar,
  ]);

  useEffect(() => {
    if (bannerVisible && dismissed) {
      setDismissed(false);
    }
  }, [bannerVisible, dismissed]);

  const handleInstall = useCallback(async () => {
    if (!updateInfo) return;
    try {
      setIsInstalling(true);
      setPhase({ type: 'installing' });

      if (fakeDesktopUpdate()) {
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        await updateInfo.install();
      }

      setPhase({ type: 'ready', version: updateInfo.version });
      setIsInstalling(false);
      setIsInstalled(true);
    } catch (err) {
      log.error('Failed to install update', err);
      setIsInstalling(false);
    }
  }, [updateInfo, setPhase]);

  const handleRestart = useCallback(async () => {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err) {
      log.error('Failed to relaunch after update', err);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    setBannerVisible(false);
  }, [setBannerVisible]);

  const bannerData = useMemo<GlobalBanner | null>(() => {
    if (!bannerVisible || !updateInfo || dismissed) return null;

    if (isInstalled) {
      return {
        id: 'desktop-update-restart',
        priority: 200,
        icon: ArrowUp,
        title: 'Update Installed',
        description: `Sable ${updateInfo.version} has been installed. Restart the app to finish updating.`,
        primaryAction: {
          label: 'Restart Now',
          variant: 'Primary',
          onClick: handleRestart,
        },
        secondaryAction: {
          label: 'Later',
          variant: 'Secondary',
          onClick: handleDismiss,
        },
      };
    }

    if (!isDownloaded) return null;

    return {
      id: 'desktop-update-ready',
      priority: 200,
      icon: ArrowUp,
      title: 'Update Available',
      description: `Sable ${updateInfo.version} is ready to install.${updateInfo.body ? `\n${updateInfo.body}` : ''}`,
      primaryAction: {
        label: isInstalling ? 'Installing...' : 'Install & Update',
        variant: 'Primary',
        onClick: handleInstall,
      },
      secondaryAction: {
        label: 'Later',
        variant: 'Secondary',
        onClick: handleDismiss,
      },
    };
  }, [
    bannerVisible,
    updateInfo,
    dismissed,
    isDownloaded,
    isInstalled,
    isInstalling,
    handleInstall,
    handleRestart,
    handleDismiss,
  ]);

  useRegisterGlobalBanner(bannerData);

  return null;
}
