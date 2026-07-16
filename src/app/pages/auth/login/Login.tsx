import { useMemo } from 'react';
import { Box, Text, color } from 'folds';
import { Link, useSearchParams } from 'react-router-dom';
import { SSOAction } from '$types/matrix-sdk';
import { RegisterFlowStatus, useAuthFlows } from '$hooks/useAuthFlows';
import { useAuthServer } from '$hooks/useAuthServer';
import { useAutoDiscoveryInfo } from '$hooks/useAutoDiscoveryInfo';
import { isOauthAwarePreferred, useParsedLoginFlows } from '$hooks/useParsedLoginFlows';
import { getLoginPath, getRegisterPath, withSearchParam } from '$pages/pathUtils';
import { usePathWithOrigin } from '$hooks/usePathWithOrigin';
import type { LoginPathSearchParams } from '$pages/paths';
import { useClientConfig } from '$hooks/useClientConfig';
import { SSOLogin } from '$pages/auth/SSOLogin';
import { OrDivider } from '$pages/auth/OrDivider';
import { PasswordLoginForm } from './PasswordLoginForm';
import { TokenLogin } from './TokenLogin';
import { OidcLoginButton, OidcCallback } from './OidcLogin';

// react-router ignores the real query string in hashRouter mode, so read callback params direct.
const getExternalSearchParams = () => {
  const params = new URLSearchParams(window.location.search);
  return {
    loginToken: params.get('loginToken') ?? undefined,
    code: params.get('code') ?? undefined,
    state: params.get('state') ?? undefined,
    error: params.get('error') ?? undefined,
    errorDescription: params.get('error_description') ?? undefined,
  };
};

const useLoginSearchParams = (searchParams: URLSearchParams): LoginPathSearchParams =>
  useMemo(
    () => ({
      username: searchParams.get('username') ?? undefined,
      email: searchParams.get('email') ?? undefined,
      loginToken: searchParams.get('loginToken') ?? undefined,
    }),
    [searchParams]
  );

export function Login() {
  const server = useAuthServer();
  const { hashRouter } = useClientConfig();
  const { hideUsernamePasswordFields } = useClientConfig();
  const { loginFlows, registerFlows, authMetadata } = useAuthFlows();
  const discovery = useAutoDiscoveryInfo();
  const baseUrl = discovery['m.homeserver'].base_url;
  const [searchParams] = useSearchParams();
  const loginSearchParams = useLoginSearchParams(searchParams);
  const ssoRedirectUrl = usePathWithOrigin(getLoginPath(server));
  const oidcRedirectUri = usePathWithOrigin(getLoginPath(server), { ignoreHashRouter: true });
  const external = getExternalSearchParams();
  const absoluteLoginPath = usePathWithOrigin(getLoginPath(server));

  if (hashRouter?.enabled && (external.loginToken || (external.code && external.state))) {
    window.location.replace(
      withSearchParam(absoluteLoginPath, {
        ...(external.loginToken ? { loginToken: external.loginToken } : {}),
        ...(external.code && external.state ? { code: external.code, state: external.state } : {}),
      })
    );
  }

  const parsedFlows = useParsedLoginFlows(loginFlows.flows);

  const isAddingAccount = searchParams.get('addAccount') === '1';

  const registerUrl = isAddingAccount
    ? withSearchParam(getRegisterPath(server), { addAccount: '1' })
    : getRegisterPath(server);

  const registrationUnavailable =
    registerFlows.status === RegisterFlowStatus.RegistrationDisabled && !parsedFlows.sso;

  const oidcCode = searchParams.get('code') ?? undefined;
  const oidcState = searchParams.get('state') ?? undefined;
  const oidcNotice = external.error
    ? (external.errorDescription ?? `Sign-in was not completed (${external.error}).`)
    : undefined;

  const showOidc = authMetadata !== undefined;
  const hidePassword =
    hideUsernamePasswordFields || (showOidc && isOauthAwarePreferred(parsedFlows.sso));
  const showPassword = !hidePassword && parsedFlows.password !== undefined;
  const showLegacySso = !showOidc && parsedFlows.sso !== undefined;

  if (showOidc && oidcCode && oidcState) {
    return <OidcCallback code={oidcCode} state={oidcState} />;
  }

  return (
    <Box direction="Column" gap="500">
      <Text size="H2" priority="400">
        Login
      </Text>
      {parsedFlows.token && loginSearchParams.loginToken && (
        <TokenLogin token={loginSearchParams.loginToken} />
      )}
      {showPassword && (
        <>
          <PasswordLoginForm
            defaultUsername={loginSearchParams.username}
            defaultEmail={loginSearchParams.email}
          />
          <span data-spacing-node />
          {(showLegacySso || showOidc) && <OrDivider />}
        </>
      )}
      {showOidc && (
        <>
          <OidcLoginButton
            authMetadata={authMetadata}
            homeserverUrl={baseUrl}
            redirectUri={oidcRedirectUri}
            label={`Continue with ${server}`}
            notice={oidcNotice}
          />
          <span data-spacing-node />
        </>
      )}
      {showLegacySso && (
        <>
          <SSOLogin
            providers={parsedFlows.sso!.identity_providers}
            redirectUrl={ssoRedirectUrl}
            action={SSOAction.LOGIN}
            saveScreenSpace={showPassword}
          />
          <span data-spacing-node />
        </>
      )}
      {!showPassword && !showLegacySso && !showOidc && (
        <>
          <Text style={{ color: color.Critical.Main }}>
            {`This client does not support login on "${server}" homeserver. Password and SSO based login method not found.`}
          </Text>
          <span data-spacing-node />
        </>
      )}
      {!registrationUnavailable && (
        <Text align="Center">
          Do not have an account? <Link to={registerUrl}>Register</Link>
        </Text>
      )}
    </Box>
  );
}
