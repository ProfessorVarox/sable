import type {
  PerMessageProfile,
  PerMessageProfileProxyAssociationV2,
} from '$hooks/usePerMessageProfile';
import {
  getAllPerMessageProfileProxies,
  getPerMessageProfileById,
} from '$hooks/usePerMessageProfile';
import type { MatrixClient } from '$types/matrix-sdk';
import { stripProxy, testProxy } from './PKitCommandMessageHandler';

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
   * a list of proxies; is not initialized in the constructor
   * @private
   * @type {PerMessageProfileProxyAssociation[]}
   * @memberof PKitProxyMessageHandler
   */
  private proxiesAssocs: PerMessageProfileProxyAssociationV2[];

  private succInit: boolean;

  /**
   * a pk proxy message handler
   * @param mx the matrix client
   */
  public constructor(mx: MatrixClient) {
    this.mx = mx;
    this.proxiesAssocs = [];
    this.succInit = false;
  }

  /**
   * initialize the handler, as this is not necessarily fast, it shouldn't happen in the constructor
   */
  public async init(): Promise<void> {
    try {
      this.proxiesAssocs = await getAllPerMessageProfileProxies(this.mx);
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
    return this.proxiesAssocs.some((assoc) => testProxy(assoc, message));
  }

  /**
   * get PmP based on message
   * @param message the message to look at
   * @returns the matching Per-Message-Profile, if any
   */
  public async getPmpBasedOnMessage(message: string): Promise<PerMessageProfile | undefined> {
    // Always refresh so newly-added proxies apply immediately.
    await this.init();
    // check if the message matches our formats
    const profileId = this.proxiesAssocs.find((assoc) => testProxy(assoc, message))?.profileId;
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
    this.proxiesAssocs.forEach((assoc) => {
      if (testProxy(assoc, message)) m = stripProxy(assoc, message);
    });
    return m;
  }
}
