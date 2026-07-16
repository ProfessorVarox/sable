import type { AccessTokens } from '$types/matrix-sdk';
import { OidcTokenRefresher } from '$types/matrix-sdk';
import type { Session } from '$state/sessions';
import {
  ACTIVE_SESSION_KEY,
  getStoredSessionRefreshToken,
  updateSessionTokens,
} from '$state/sessions';
import { getLocalStorageItem } from '$state/utils/atomWithLocalStorage';
import { pushSessionToSW } from '../sw-session';

export class SessionOidcTokenRefresher extends OidcTokenRefresher {
  private readonly userId: string;

  private readonly baseUrl: string;

  public constructor(session: Session) {
    if (!session.oidc) {
      throw new Error('SessionOidcTokenRefresher requires an OIDC session');
    }
    super(
      session.oidc.issuer,
      session.oidc.clientId,
      window.location.origin,
      session.deviceId,
      session.oidc.idTokenClaims ?? ({} as never)
    );
    this.userId = session.userId;
    this.baseUrl = session.baseUrl;
  }

  // Another tab may have rotated the token; reusing a consumed one revokes the session.
  public override doRefreshAccessToken(refreshToken: string): Promise<AccessTokens> {
    return super.doRefreshAccessToken(getStoredSessionRefreshToken(this.userId) ?? refreshToken);
  }

  protected async persistTokens(tokens: {
    accessToken: string;
    refreshToken?: string;
  }): Promise<void> {
    const { expiry } = tokens as { expiry?: Date };
    updateSessionTokens(this.userId, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresInMs: expiry ? expiry.getTime() - Date.now() : undefined,
    });
    // Only the active session owns the single service-worker session.
    const activeSessionId = getLocalStorageItem<string | undefined>(ACTIVE_SESSION_KEY, undefined);
    if (activeSessionId === this.userId) {
      pushSessionToSW(this.baseUrl, tokens.accessToken, this.userId);
    }
  }
}
