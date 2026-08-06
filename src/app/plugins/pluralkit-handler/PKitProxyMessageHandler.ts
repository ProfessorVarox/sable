import type { PerMessageProfileMsc4461 } from '$hooks/usePerMessageProfile';
import { getAllPerMessageProfiles, getPerMessageProfileById } from '$hooks/usePerMessageProfile';
import type { MatrixClient } from '$types/matrix-sdk';
import { stripTrigger, testTriggers } from './PKitCommandMessageHandler';

/**
 * proxy message handler
 * @author Rye
 */
export class PKitProxyMessageHandler {
  /**
   * the matrix client we use, we init that in the constructor
   *
   * @private
   * @type {MatrixClient}
   * @memberof PKitProxyMessageHandler
   */
  private readonly mx: MatrixClient;

  /**
   * a list of profiles; is not initialized in the constructor
   * @private
   * @type {PerMessageProfileMsc4461[]}
   * @memberof PKitProxyMessageHandler
   */
  private profiles: PerMessageProfileMsc4461[];

  private succInit: boolean;

  /**
   * a pk proxy message handler
   * @param mx the matrix client
   */
  public constructor(mx: MatrixClient) {
    this.mx = mx;
    this.profiles = [];
    this.succInit = false;
  }

  /**
   * initialize the handler, as this is not necessarily fast, it shouldn't happen in the constructor
   */
  public async init(): Promise<void> {
    try {
      this.profiles = await getAllPerMessageProfiles(this.mx);
      this.succInit = true;
    } catch (err) {
      this.succInit = false;
      throw new Error(`failed to init pmp proxy handler: ${String(err)}`, {
        cause: err,
      });
    }
  }

  /**
   * you should probably check this before running `getPmpBasedOnMessage`, as this is faster
   * @param message the message to check
   */
  public isAProxiedMessage(message: string): boolean {
    if (!this.succInit) return false;
    return this.profiles.some((profile) => testTriggers(profile.trigger, message));
  }

  /**
   * get PmP based on message
   * @param message the message to look at
   * @returns the matching Per-Message-Profile, if any
   */
  public async getPmpBasedOnMessage(
    message: string
  ): Promise<PerMessageProfileMsc4461 | undefined> {
    // Always refresh so newly-added proxies apply immediately.
    await this.init();
    // check if the message matches our formats
    const profileId = this.profiles.find((profile) => testTriggers(profile.trigger, message))?.id;
    if (!profileId) return undefined;
    return getPerMessageProfileById(this.mx, profileId);
  }

  /**
   * this runs synchronously, so it needs to be inited beforehand
   *
   * @param {string} message the message you want to extract from
   * @return {*}  {(string | undefined)} the message without the proxy
   * @memberof PKitProxyMessageHandler
   */
  public stripProxyFromMessage(message: string): string | undefined {
    if (!this.succInit) return undefined;
    let m;
    this.profiles.forEach((profile) => {
      if (testTriggers(profile.trigger, message)) m = stripTrigger(profile.trigger, message);
    });
    return m;
  }
}
