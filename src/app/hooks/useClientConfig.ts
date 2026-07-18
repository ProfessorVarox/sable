import { createContext, useContext } from 'react';

import type { Settings } from '$state/settings';

export type HashRouterConfig = {
  enabled?: boolean;
  basename?: string;
};

export type GifsConfig = {
  klipyApiKey?: string;
  proxyUrl?: string;
};

export type ClientConfig = {
  defaultHomeserver?: number;
  homeserverList?: string[];
  allowCustomHomeservers?: boolean;
  elementCallUrl?: string;

  disableAccountSwitcher?: boolean;
  hideUsernamePasswordFields?: boolean;

  pushNotificationDetails?: {
    pushNotifyUrl?: string;
    vapidPublicKey?: string;
    webPushAppID?: string;
  };

  featuredCommunities?: {
    openAsDefault?: boolean;
    spaces?: string[];
    rooms?: string[];
    servers?: string[];
  };

  hashRouter?: HashRouterConfig;

  gifs?: GifsConfig;

  matrixToBaseUrl?: string;

  themeCatalogBaseUrl?: string;
  themeCatalogManifestUrl?: string;
  themeCatalogApprovedHostPrefixes?: string[];

  settingsDefaults?: Partial<Settings>;
};

const EMPTY_CONFIG: ClientConfig = {};

const ClientConfigContext = createContext<ClientConfig>(EMPTY_CONFIG);

export const ClientConfigProvider = ClientConfigContext.Provider;

export function useClientConfig(): ClientConfig {
  return useContext(ClientConfigContext);
}

export function useOptionalClientConfig(): ClientConfig {
  return useContext(ClientConfigContext);
}

export const clientDefaultServer = (clientConfig: ClientConfig): string =>
  clientConfig.homeserverList?.[clientConfig.defaultHomeserver ?? 0] ?? 'matrix.org';

export const clientAllowedServer = (clientConfig: ClientConfig, server: string): boolean => {
  const { homeserverList, allowCustomHomeservers } = clientConfig;

  if (allowCustomHomeservers) return true;

  return homeserverList?.includes(server) === true;
};
