import type { AccountDataCompatVersion } from '$types/matrix/accountData';

import type { PronounSet } from '$utils/pronouns';
import type { MatrixClient } from '$types/matrix-sdk';
import { CustomAccountDataEvent } from '$types/matrix/accountData';
import type { ColorSet } from './useUserProfile';
import {
  MATRIX_UNSTABLE_COLORS,
  MATRIX_SABLE_UNSTABLE_MSC4461_TRIGGER_CIRCUMFIX_PROPERTY_NAME,
  MATRIX_SABLE_UNSTABLE_MSC4461_TRIGGER_SUFFIX_PROPERTY_NAME,
  MATRIX_UNSTABLE_MSC4461_ACCOUNT_PER_MESSAGE_PROFILES_PROPERTY_NAME,
  MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME,
} from '$unstable/prefixes';
import { createKeyedQueue } from '$utils/keyedQueue';

const ACCOUNT_DATA_PREFIX = CustomAccountDataEvent.SablePerProfileMessageProfiles;

/** Account data is read-modify-written, so writes to the same key must not interleave. */
const enqueueProfilePersistence = createKeyedQueue();

/**
 * @deprecated in favour if {@link PerMessageProfileMsc4461}
 * a per message profile
 */
type PerMessageProfile = {
  /**
   * a unique id for this profile, can be generated using something like nanoid.
   * This is used to identify the profile when applying it to a message, and also used as the key when storing the profile in account data.
   */
  id: string;
  /**
   * the display name to use for messages using this profile.
   * This is required because otherwise the profile would have no effect on the message.
   */
  name: string;
  /**
   * the avatar url to use for messages using this profile.
   */
  avatarUrl?: string;
  /**
   * a per message profile can also include pronouns
   * @see PronounSet for the format of the pronouns, and how to parse them from a string input
   */
  pronouns?: PronounSet[];
  compat?: AccountDataCompatVersion;
  colors?: ColorSet;
};

export type ProfileTrigger = {
  prefix: string[];
  [MATRIX_SABLE_UNSTABLE_MSC4461_TRIGGER_SUFFIX_PROPERTY_NAME]?: string[];
  [MATRIX_SABLE_UNSTABLE_MSC4461_TRIGGER_CIRCUMFIX_PROPERTY_NAME]?: {
    prefix: string;
    suffix: string;
  }[];
};

/**
 * a per message profile
 */
export type PerMessageProfileIndexMsc4461 = {
  profiles: PerMessageProfileMsc4461[];
};

/**
 * a per message profile
 */
export type PerMessageProfileMsc4461 = {
  /**
   * a unique id for this profile, can be generated using something like nanoid.
   * This is used to identify the profile when applying it to a message, and also used as the key when storing the profile in account data.
   */
  id: string;
  /**
   * the display name to use for messages using this profile.
   * This is required because otherwise the profile would have no effect on the message.
   */
  displayname: string;
  /**
   * the avatar url to use for messages using this profile.
   */
  avatar_url?: string;
  /**
   * a per message profile can also include pronouns
   * @see PronounSet for the format of the pronouns, and how to parse them from a string input
   */
  [MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME]?: PronounSet[];

  /**
   * following spec MSC4522
   */
  [MATRIX_UNSTABLE_COLORS]?: ColorSet;

  trigger: ProfileTrigger;

  compat?: AccountDataCompatVersion;
};

function isPerMessageProfileIndex(content: unknown): content is PerMessageProfileIndexMsc4461 {
  return (
    typeof content === 'object' &&
    content !== null &&
    'profiles' in content &&
    Array.isArray(content.profiles)
  );
}

function getPerMessageProfileIndex(mx: MatrixClient): PerMessageProfileIndexMsc4461 | undefined {
  const content = mx
    .getAccountData(
      MATRIX_UNSTABLE_MSC4461_ACCOUNT_PER_MESSAGE_PROFILES_PROPERTY_NAME as Parameters<
        typeof mx.getAccountData
      >[0]
    )
    ?.getContent();

  if (isPerMessageProfileIndex(content)) return content;
  if (typeof content !== 'object' || content === null || !('content' in content)) return undefined;

  return isPerMessageProfileIndex(content.content) ? content.content : undefined;
}

async function savePerMessageProfileIndex(mx: MatrixClient, profiles: PerMessageProfileMsc4461[]) {
  await mx.setAccountData(
    MATRIX_UNSTABLE_MSC4461_ACCOUNT_PER_MESSAGE_PROFILES_PROPERTY_NAME as Parameters<
      typeof mx.setAccountData
    >[0],
    { profiles } as Parameters<typeof mx.setAccountData>[1]
  );
}

export function convertPmpToMsc4461(
  mx: MatrixClient,
  profile: PerMessageProfile
): PerMessageProfileMsc4461 {
  const triggers: ProfileTrigger = {
    prefix: [],
    [MATRIX_SABLE_UNSTABLE_MSC4461_TRIGGER_SUFFIX_PROPERTY_NAME]: [],
    [MATRIX_SABLE_UNSTABLE_MSC4461_TRIGGER_CIRCUMFIX_PROPERTY_NAME]: [],
  };

  // lookup old proxyAssociations
  getProxyAssociationMap(
    mx
      .getAccountData(
        `${ACCOUNT_DATA_PREFIX}.proxyassociation` as Parameters<typeof mx.getAccountData>[0]
      )
      ?.getContent()
    /* oxlint-disable no-unused-vars */
  )
    .entries()
    .filter(([_k, assoc]) => assoc.profileId === profile.id)
    .forEach(([k, assoc]) => {
      const migratedAssoc = migratePmpProxyAssociation(k, assoc);
      if (!migratedAssoc) return;

      if (migratedAssoc.prefix && !migratedAssoc.suffix) {
        triggers.prefix.push(migratedAssoc.prefix);
      } else if (!migratedAssoc.prefix && migratedAssoc.suffix) {
        triggers[MATRIX_SABLE_UNSTABLE_MSC4461_TRIGGER_SUFFIX_PROPERTY_NAME]!.push(
          migratedAssoc.suffix
        );
      } else if (migratedAssoc.prefix && migratedAssoc.suffix) {
        triggers[MATRIX_SABLE_UNSTABLE_MSC4461_TRIGGER_CIRCUMFIX_PROPERTY_NAME]!.push({
          prefix: migratedAssoc.prefix,
          suffix: migratedAssoc.suffix,
        });
      }
    });

  const newPmp: PerMessageProfileMsc4461 = {
    id: profile.id,
    displayname: profile.name,
    avatar_url: profile.avatarUrl,
    [MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME]: profile.pronouns,
    [MATRIX_UNSTABLE_COLORS]: profile.colors,
    trigger: triggers,
  };

  // delete empty fields
  // to-do maybe find a better way of doing it
  if (!profile.avatarUrl) delete newPmp.avatar_url;
  if (!profile.pronouns || profile.pronouns?.length === 0)
    delete newPmp[MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME];
  if (!profile.colors) delete newPmp[MATRIX_UNSTABLE_COLORS];
  return newPmp;
}

/**
 * the format used by Beeper for per message profiles
 * This is the format that Beeper expects when applying a profile to a message before sending it
 */
export type PerMessageProfileBeeperFormat = {
  /**
   * the unique id for this profile, which is used to identify the profile when applying it to a message, and also used as the key when storing the profile in account data.
   */
  id: string;
  /**
   * the display name to use for messages using this profile. This is required because otherwise the profile would have no effect on the message.
   */
  displayname?: string;
  /**
   * the avatar url to use for messages using this profile.
   * Beeper expects this to be a mxc url.
   */
  avatar_url?: string;
  /**
   * using the unstable prefix for pronouns, under which it is also stored in profiles
   */
  [MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME]?: PronounSet[];

  [MATRIX_UNSTABLE_COLORS]?: ColorSet;
  has_fallback?: boolean;
};

/**
 * converts a per message profile from our format to the format used by Beeper, which is used when applying the profile to a message before sending it.
 * We have out own format because we want to have more control over the data and how it's stored in account data.
 * @export
 * @param {PerMessageProfile} profile the per message profile in our format
 * @return {*}  {PerMessageProfileBeeperFormat} the per message profile in Beeper's format, which can be applied to a message before sending it
 */
export function convertPerMessageProfileToBeeperFormat(
  profile: PerMessageProfileMsc4461,
  has_fallback: boolean
): PerMessageProfileBeeperFormat {
  const beeperPMP: PerMessageProfileBeeperFormat = {
    id: profile.id,
    displayname: profile.displayname,
    avatar_url: profile.avatar_url,
    [MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME]:
      profile[MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME],
    [MATRIX_UNSTABLE_COLORS]: profile[MATRIX_UNSTABLE_COLORS],
    has_fallback,
  };
  // delete empty fields
  // to-do maybe find a better way of doing it
  if (!profile.displayname || profile?.displayname.trim().length === 0)
    delete beeperPMP.displayname;
  if (!profile.avatar_url) delete beeperPMP.avatar_url;
  if (
    !profile[MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME] ||
    profile[MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME]?.length === 0
  )
    if (!profile[MATRIX_UNSTABLE_COLORS]) delete beeperPMP[MATRIX_UNSTABLE_COLORS];
  if (!has_fallback) delete beeperPMP.has_fallback;
  return beeperPMP;
}

/**
 * converts a per message profile from Beeper's format to our format, which is used when storing the profile in account data and using it in the app.
 * We have our own format because we want to have more control over the data and how it's stored in account data.
 *
 * @export
 * @param {PerMessageProfileBeeperFormat} beeperProfile the per message profile in Beeper's format
 * @return {*}  {PerMessageProfile} the per message profile in our format, which can be stored in account data and used in the app
 */
export function convertBeeperFormatToOurPerMessageProfile(
  beeperProfile: PerMessageProfileBeeperFormat
): PerMessageProfileMsc4461 {
  return {
    id: beeperProfile.id,
    displayname: beeperProfile.displayname ?? '',
    avatar_url: beeperProfile.avatar_url,
    [MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME]:
      beeperProfile[MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME],
    [MATRIX_UNSTABLE_COLORS]: beeperProfile[MATRIX_UNSTABLE_COLORS],
    trigger: { prefix: [] },
  };
}

type PerMessageProfileIndex = {
  /**
   * a list of all profile ids, used to list all profiles when the user wants to manage them.
   */
  profileIds: string[];
  compat: AccountDataCompatVersion;
};

/**
 * how we will store room associations in the account data :3
 */
type PerMessageProfileRoomAssociation = {
  profileId: string;
  validUntil?: number;
};

type ProxyVariation =
  | { prefix: string; suffix: undefined }
  | { prefix: undefined; suffix: string }
  | { prefix: string; suffix: string };

/**
 * Deprecated in favor of {@link PerMessageProfileProxyAssociationV2}, kept for migration purposes
 */
export type PerMessageProfileProxyAssociationV1 = {
  profileId: string;
  /**
   * @deprecated regex (string representation of it) to handle the proxy
   */
  regexString: string;
  setAt?: number;
};

export type PerMessageProfileProxyAssociationV2 = {
  /**
   * the profile associated with the proxy
   */
  profileId: string;

  /**
   * optional parameter to save when the proxy was added
   */
  setAt?: number;

  prefix: string | undefined;
  suffix: string | undefined;
};

/**
 * associating a profile by proxy
 * @author Rye
 */
export type PerMessageProfileProxyAssociation =
  | PerMessageProfileProxyAssociationV1
  | PerMessageProfileProxyAssociationV2;

/**
 * @deprecated in favor of {@link PerMessageProfileProxyAssociationV2}
 */
export type InternalPerMessageProfileProxyAssociation = {
  /**
   * the profile associated with the proxy
   */
  profileId: string;
  /**
   * regex to handle the proxy
   */
  regex: RegExp;
  /**
   * optional parameter to save when the proxy was added
   */
  setAt?: number;
};

/**
 * Used to migrate old format proxy tags to new format.
 * @author Josie F0rest
 */
export function extractCircumfixProxyTagsFromKey(proxyId: string): ProxyVariation | null {
  const [prefix, suffix] = proxyId.split('text');

  /*
    i tried to do this a smart unpacking way but tsc did not like it. sorry for if-else spam.
    feel free to clean this up if you can pass tsc
  */
  if (!prefix && !suffix) {
    return null;
  } else if (prefix && !suffix) {
    return { prefix, suffix: undefined };
  } else if (!prefix && suffix) {
    return { prefix: undefined, suffix };
  } else {
    return { prefix: prefix!, suffix: suffix! };
  }
}

export function createProxyKey(prefix: string | undefined, suffix: string | undefined) {
  return `${prefix || ''}text${suffix || ''}`;
}

export function proxyNeedsMigration(assoc: PerMessageProfileProxyAssociation) {
  return (assoc as PerMessageProfileProxyAssociationV1).regexString !== undefined;
}

export function migratePmpProxyAssociation(
  proxyId: string,
  assoc: PerMessageProfileProxyAssociation
): PerMessageProfileProxyAssociationV2 | null {
  /* detect old proxy association */
  if ((assoc as PerMessageProfileProxyAssociationV1).regexString) {
    const fixes = extractCircumfixProxyTagsFromKey(proxyId);
    if (!fixes) return null;
    return {
      profileId: assoc.profileId,
      ...(assoc.setAt && { setAt: assoc.setAt! }),
      ...fixes,
    };
  } else {
    return assoc as PerMessageProfileProxyAssociationV2;
  }
}

/**
 * @deprecated in favor of {@link PerMessageProfileProxyAssociationV2}
 */
export function parsePerMessageProfileProxyAssociation(
  assoc: PerMessageProfileProxyAssociationV1
): InternalPerMessageProfileProxyAssociation {
  const m = assoc.regexString.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
  const source = m?.[1] ?? assoc.regexString;
  const flags = m?.[2] ?? '';
  return {
    profileId: assoc.profileId,
    regex: new RegExp(source, flags),
    setAt: assoc.setAt,
  } satisfies InternalPerMessageProfileProxyAssociation;
}

type PerMessageProfileProxyAssociationWrapper = {
  /**
   * the associations saved in the wrapper
   */
  associations:
    | Map<string, PerMessageProfileProxyAssociation>
    | Record<string, PerMessageProfileProxyAssociation>;
  /**
   * optional parameter to save compatibility information
   */
  compat?: AccountDataCompatVersion;
};

/**
 * the shape of the account data for room associations, which is a wrapper around a list of associations.
 * This is used to store the associations in account data, and allows us to easily add additional fields in the future if needed without breaking the existing data structure.
 */
type PerMessageProfileRoomAssociationWrapper = {
  /**
   * Key-Value pairs of room ids and profile ids, used to apply a profile to all messages in a room without having to set the profile for each message individually.
   * The key is the room id, and the value is the profile id. The profile id can then be used to fetch the profile data when applying the profile to a message before sending it.
   *
   * @type {Map<string, PerMessageProfileRoomAssociation>}
   */
  associations:
    | Map<string, PerMessageProfileRoomAssociation>
    | Record<string, PerMessageProfileRoomAssociation>;
  compat?: AccountDataCompatVersion;
};

/**
 * the shape of the account data for room associations, which is a wrapper around a list of associations.
 * This is used to store the associations in account data, and allows us to easily add additional fields in the future if needed without breaking the existing data structure.
 */
type PerMessageProfileGlobalAssociationWrapper = {
  /**
   * Key-Value pairs of room ids and profile ids, used to apply a profile to all messages in a room without having to set the profile for each message individually.
   * The key is the room id, and the value is the profile id. The profile id can then be used to fetch the profile data when applying the profile to a message before sending it.
   *
   * @type {Map<string, PerMessageProfileRoomAssociation>}
   */
  association: PerMessageProfileRoomAssociation;
  compat?: AccountDataCompatVersion;
};

/**
 * unwrap a profile-room-associations-wrapper
 * @param wrapper the wrapper to unwrap
 * @returns unwrapped map for profile-room-associations
 */
function getAssociationsMap(
  wrapper?: PerMessageProfileRoomAssociationWrapper
): Map<string, PerMessageProfileRoomAssociation> {
  if (!wrapper?.associations) return new Map();
  if (wrapper.associations instanceof Map) return wrapper.associations;
  return new Map(Object.entries(wrapper.associations));
}

// Helper to always get a plain object from a Map
function associationsMapToObject(
  map: Map<string, PerMessageProfileRoomAssociation>
): Record<string, PerMessageProfileRoomAssociation> {
  return Object.fromEntries(map);
}

/**
 * helper function (similar to getAssociationsMap for Room associations)
 * @param wrapper the wrapper to unwrap
 * @returns unwrapped map of proxy associations
 */
function getProxyAssociationMap(
  wrapper?: PerMessageProfileProxyAssociationWrapper
): Map<string, PerMessageProfileProxyAssociation> {
  if (!wrapper?.associations) return new Map();
  if (wrapper.associations instanceof Map) return wrapper.associations;
  return new Map(Object.entries(wrapper.associations));
}

function proxyAssociationsMapToObject(
  map: Map<string, PerMessageProfileProxyAssociation>
): Record<string, PerMessageProfileProxyAssociation> {
  return Object.fromEntries(map);
}

/**
 * helper function: getting a profile from the account data where the profile matches a given id
 *
 * @export
 * @param {MatrixClient} mx the matrix client
 * @param {string} id the profile id
 * @return {*}  {(Promise<PerMessageProfileMsc4461 | undefined>)} the profile, with the profile Id, if it exists
 */
export async function getPerMessageProfileById(
  mx: MatrixClient,
  id: string
): Promise<PerMessageProfileMsc4461 | undefined> {
  return getPerMessageProfileIndex(mx)?.profiles.find((profile) => profile.id === id);
}

/**
 * @deprecated
 *
 * getting a profile from the account data where the profile matches a given id
 *
 * @export
 * @param {MatrixClient} mx the matrix client
 * @param {string} id the profile id
 * @return {*}  {(Promise<PerMessageProfile | undefined>)} the profile, with the profile Id, if it exists
 */
async function getPerMessageProfileByIdDeprecated(
  mx: MatrixClient,
  id: string
): Promise<PerMessageProfile | undefined> {
  const profile = mx.getAccountData(
    `${ACCOUNT_DATA_PREFIX}.${id}` as Parameters<typeof mx.getAccountData>[0]
  );
  return profile ? (profile.getContent() as unknown as PerMessageProfile) : undefined;
}

async function migrateLegacyPerMessageProfiles(
  mx: MatrixClient
): Promise<PerMessageProfileMsc4461[] | undefined> {
  const profileIndex = mx.getAccountData(
    `${ACCOUNT_DATA_PREFIX}.index` as Parameters<typeof mx.getAccountData>[0]
  );
  if (!profileIndex) return undefined;

  const profileIds = (profileIndex.getContent() as PerMessageProfileIndex).profileIds ?? [];
  const legacyProfiles = await Promise.all(
    profileIds.map((id) => getPerMessageProfileByIdDeprecated(mx, id))
  );
  const profiles = legacyProfiles
    .filter((profile): profile is PerMessageProfile => profile !== undefined)
    .map((profile) => convertPmpToMsc4461(mx, profile));

  await savePerMessageProfileIndex(mx, profiles);
  await Promise.all([
    mx.deleteAccountData(
      `${ACCOUNT_DATA_PREFIX}.index` as Parameters<typeof mx.deleteAccountData>[0]
    ),
    ...legacyProfiles
      .filter((profile): profile is PerMessageProfile => profile !== undefined)
      .map((profile) =>
        mx.deleteAccountData(
          `${ACCOUNT_DATA_PREFIX}.${profile.id}` as Parameters<typeof mx.deleteAccountData>[0]
        )
      ),
  ]);

  return profiles;
}

/**
 * getting an array of all PerMessageProfile's saved in the account data
 *
 * @export
 * @param {MatrixClient} mx the matrix client
 * @return {*}  {Promise<PerMessageProfile[]>} a array containing all per-message-profiles saved
 */
export async function getAllPerMessageProfiles(
  mx: MatrixClient
): Promise<PerMessageProfileMsc4461[]> {
  const profiles = getPerMessageProfileIndex(mx)?.profiles;
  if (profiles) return profiles;

  return (await migrateLegacyPerMessageProfiles(mx)) ?? [];
}

/**
 * add or update a pmp
 * @param mx the matrix client
 * @param profile the profile to add/update
 * @returns void
 */
export async function addOrUpdatePerMessageProfile(
  mx: MatrixClient,
  profile: PerMessageProfileMsc4461
) {
  const profiles = getPerMessageProfileIndex(mx)?.profiles ?? [];
  const existingIndex = profiles.findIndex((existingProfile) => existingProfile.id === profile.id);
  const updatedProfiles =
    existingIndex === -1
      ? [...profiles, profile]
      : profiles.map((existingProfile) =>
          existingProfile.id === profile.id ? profile : existingProfile
        );

  await savePerMessageProfileIndex(mx, updatedProfiles);
}

async function getRoomsUsingProfile(mx: MatrixClient, profileId: string): Promise<string[]> {
  const accountData = mx.getAccountData(
    `${ACCOUNT_DATA_PREFIX}.roomassociation` as Parameters<typeof mx.getAccountData>[0]
  );
  const content: PerMessageProfileRoomAssociationWrapper | undefined = accountData?.getContent();
  const associations = getAssociationsMap(content);
  const roomsUsingProfile: string[] = [];
  Array.from(associations.entries()).forEach(([roomId, assoc]) => {
    if (assoc?.profileId === profileId) roomsUsingProfile.push(roomId);
  });
  return roomsUsingProfile;
}

/**
 * sets the per message profile to be used for messages in a room. This is done by setting account data with a list of room associations, which is then checked when sending a message to apply the profile to the message if the room matches an association. The associations can also have an optional expiration time, after which they will be ignored and removed.
 * @param mx matrix client
 * @param roomId the room id your querying for
 * @param profileId the profile id you are querying for
 * @param validUntil the timestamp until the pmp association is valid
 * @param reset if true, the association for the room will be removed, if false and profileId is undefined, the association will be set to undefined but not removed, meaning it will still be visible in the list of associations but won't have any effect. This is useful for resetting the association without losing the information of which profile was associated before.
 * @returns promose that resolves when the association has been set
 */
export async function setCurrentlyUsedPerMessageProfileIdForRoom(
  mx: MatrixClient,
  roomId: string,
  profileId: string | undefined,
  validUntil?: number,
  reset?: boolean
) {
  return enqueueProfilePersistence('roomassociation', async () => {
    const accountData = mx.getAccountData(
      `${ACCOUNT_DATA_PREFIX}.roomassociation` as Parameters<typeof mx.getAccountData>[0]
    );
    const content: PerMessageProfileRoomAssociationWrapper | undefined = accountData?.getContent();
    const associations = getAssociationsMap(content);

    if (reset) {
      associations.delete(roomId);
      await mx.setAccountData(
        `${ACCOUNT_DATA_PREFIX}.roomassociation` as Parameters<typeof mx.setAccountData>[0],
        { associations: associationsMapToObject(associations) } as Parameters<
          typeof mx.setAccountData
        >[1]
      );
      return;
    }
    if (!profileId) {
      throw new Error("profile Id is empty, yet it isn't a reset");
    }
    associations.set(roomId, { profileId, validUntil });
    await mx.setAccountData(
      `${ACCOUNT_DATA_PREFIX}.roomassociation` as Parameters<typeof mx.setAccountData>[0],
      { associations: associationsMapToObject(associations) } as Parameters<
        typeof mx.setAccountData
      >[1]
    );
  });
}

/**
 * todo
 */
export async function setCurrentlyUsedPerMessageProfileIdForAccount(
  mx: MatrixClient,
  profileId: string | undefined,
  validUntil?: number,
  reset?: boolean
) {
  return enqueueProfilePersistence('globalassociation', async () => {
    if (reset) {
      await mx.deleteAccountData(
        `${ACCOUNT_DATA_PREFIX}.globalassociation` as Parameters<typeof mx.setAccountData>[0]
      );
      return;
    }
    if (!profileId) {
      throw new Error("profile Id is empty, yet it isn't a reset");
    }

    const association: PerMessageProfileRoomAssociation = { profileId, validUntil };

    await mx.setAccountData(
      `${ACCOUNT_DATA_PREFIX}.globalassociation` as Parameters<typeof mx.setAccountData>[0],
      { association: association } as Parameters<typeof mx.setAccountData>[1]
    );
  });
}

/*
 * @deprecated in favor of Msc4461 format triggers
 */
export async function getAllProxiesForPMP(
  mx: MatrixClient,
  profileId: string
): Promise<PerMessageProfileProxyAssociationV2[]> {
  const cont: PerMessageProfileProxyAssociationWrapper | undefined = mx
    .getAccountData(
      `${ACCOUNT_DATA_PREFIX}.proxyassociation` as Parameters<typeof mx.getAccountData>[0]
    )
    ?.getContent();
  if (!cont) return [];

  const pmap = getProxyAssociationMap(cont);
  const parr = new Array<PerMessageProfileProxyAssociationV2>();
  pmap
    .entries()
    /* oxlint-disable no-unused-vars */
    .filter(([_k, v]) => v.profileId === profileId)
    .forEach(([k, v]) => parr.push(migratePmpProxyAssociation(k, v)!));
  return parr;
}

/**
 *
 * drops all room associations for a profile, used when deleting a profile to make sure there are no dangling associations left that point to a non existing profile, which could cause issues when trying to apply the profile to a message in a room that still has an association for the deleted profile.
 *
 * @param {MatrixClient} mx the matrix client
 * @param {string} id the id of the profile to drop associations for
 */
async function dropPerMessageProfileRoomAssociations(mx: MatrixClient, id: string) {
  const accountData = mx.getAccountData(
    `${ACCOUNT_DATA_PREFIX}.roomassociation` as Parameters<typeof mx.getAccountData>[0]
  );
  const content: PerMessageProfileRoomAssociationWrapper | undefined = accountData?.getContent();
  if (!content) return;
  const associations = getAssociationsMap(content);
  const roomsUsingProfile = await getRoomsUsingProfile(mx, id);
  if (roomsUsingProfile.length === 0) return;
  roomsUsingProfile.forEach((roomId) => {
    associations.delete(roomId);
  });
  await mx.setAccountData(
    `${ACCOUNT_DATA_PREFIX}.roomassociation` as Parameters<typeof mx.setAccountData>[0],
    { associations: associationsMapToObject(associations) } as Parameters<
      typeof mx.setAccountData
    >[1]
  );
}

/**
 * deletes a per message profile by its id
 * @param mx the matrix client
 * @param id the id of the profile to delete
 */
export async function deletePerMessageProfile(mx: MatrixClient, id: string) {
  await dropPerMessageProfileRoomAssociations(mx, id);
  const profiles = getPerMessageProfileIndex(mx)?.profiles;
  if (!profiles) return;

  await savePerMessageProfileIndex(
    mx,
    profiles.filter((profile) => profile.id !== id)
  );
}

/**
 * move a profile from one id to another, used when renaming a profile to change the id.
 * This is done by creating a new profile with the new id and the same data as the old profile, and then deleting the old profile.
 * @param mx the matrix client
 * @param oldId the id the profile is currently saved under
 * @param newId the id it will be moved to
 */
export async function renamePerMessageProfile(mx: MatrixClient, oldId: string, newId: string) {
  const profiles = getPerMessageProfileIndex(mx)?.profiles;
  if (!profiles?.some((profile) => profile.id === oldId)) {
    throw new Error('Profile not found');
  }

  await savePerMessageProfileIndex(
    mx,
    profiles.map((profile) => (profile.id === oldId ? { ...profile, id: newId } : profile))
  );
}

/**
 * gets the per message profile to be used for messages in a room
 * @param mx matrix client
 * @param roomId the room id you are querying for
 * @returns the profile to be used
 */
export async function getCurrentlyUsedPerMessageProfileForRoom(
  mx: MatrixClient,
  roomId: string
): Promise<PerMessageProfileMsc4461 | undefined> {
  const accountData = mx.getAccountData(
    `${ACCOUNT_DATA_PREFIX}.roomassociation` as Parameters<typeof mx.getAccountData>[0]
  );
  const content: PerMessageProfileRoomAssociationWrapper | undefined = accountData?.getContent();
  const associations = getAssociationsMap(content);
  const profileId = associations.get(roomId)?.profileId;
  const pmp = profileId ? await getPerMessageProfileById(mx, profileId) : undefined;
  return profileId ? pmp : undefined;
}

/**
 * get the per message profile associated with the account todo
 */
export async function getCurrentlyUsedPerMessageProfileForAccount(
  mx: MatrixClient
): Promise<PerMessageProfileMsc4461 | undefined> {
  const accountData = mx.getAccountData(
    `${ACCOUNT_DATA_PREFIX}.globalassociation` as Parameters<typeof mx.getAccountData>[0]
  );
  const content: PerMessageProfileGlobalAssociationWrapper | undefined = accountData?.getContent();
  const profileId = content?.association.profileId;
  const pmp = profileId ? await getPerMessageProfileById(mx, profileId) : undefined;
  return profileId ? pmp : undefined;
}

/*
 * If you don't supply a profile, it may fail if the displayname has a colon.
 */
export function stripPerMessageProfilePlainBody(
  formatted_body: string,
  profile?: PerMessageProfileMsc4461
): string {
  if (profile) {
    return formatted_body.replace(`${profile.displayname}: `, '');
  } else {
    return formatted_body.replace(/^.*?: /, '');
  }
}
export function stripPerMessageProfileFormattedBody(formatted_body: string): string {
  return formatted_body.replace(/^<strong\s+data-mx-profile-fallback[^>]*>.*?<\/strong>/, '');
}
