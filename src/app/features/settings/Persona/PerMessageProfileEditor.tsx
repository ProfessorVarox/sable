import { SequenceCard, SequenceCardStyle } from '$components/sequence-card';
import { Box, Button, Text, Avatar, config, IconButton, Input, toRem, Spinner, color } from 'folds';
import { menuIcon, Trash, X } from '$components/icons/phosphor';
import type { MatrixClient } from '$types/matrix-sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { nameInitials } from '$utils/common';
import { mxcUrlToHttp } from '$utils/matrix';
import { useFilePicker } from '$hooks/useFilePicker';
import { useMediaAuthentication } from '$hooks/useMediaAuthentication';
import { useObjectURL } from '$hooks/useObjectURL';
import { createUploadAtom } from '$state/upload';
import { UserAvatar } from '$components/user-avatar';
import { CompactUploadCardRenderer } from '$components/upload-card';
import {
  addOrUpdatePerMessageProfile,
  associateProxyWithProfile,
  createProxyKey,
  deletePerMessageProfile,
  dropProxyAssociationForPMP,
  getAllPerMessageProfileProxies,
  getAllProxiesForPMP,
  getPerMessageProfileById,
  type PerMessageProfileProxyAssociationV2,
  renamePerMessageProfile,
} from '$hooks/usePerMessageProfile';
import type { PronounSet } from '$utils/pronouns';
import { parsePronounsStringToPronounsSetArray } from '$utils/pronouns';
import { generateShortId } from '$utils/shortIdGen';
import { SettingTile } from '$components/setting-tile';
import { type AsyncState, AsyncStatus, useAsyncCallback } from '$hooks/useAsyncCallback';
import { NameColorEditor } from '../account/NameColorEditor';

const constructProxyString = (s: Shorthand) => {
  return `${s.prefix ?? ''}text${s.suffix ?? ''}`;
};

type Shorthand = { id: string; prefix?: string; suffix?: string };
type ShorthandRow = Shorthand & { rowId: string };

type ShorthandListItemProps = Shorthand & {
  onDelete: (shorthandId: string) => void;
  onSave: (shorthandId: string, shorthand: Shorthand) => void;
  deleteState: AsyncState<void>;
  saveState: AsyncState<void>;
};
function ShorthandListItem({
  id,
  prefix,
  suffix,
  onDelete,
  onSave,
  deleteState,
  saveState,
}: ShorthandListItemProps) {
  const [currentPrefix] = useState(prefix);
  const [currentSuffix] = useState(suffix);
  const [newPrefix, setNewPrefix] = useState(prefix);
  const [newSuffix, setNewSuffix] = useState(suffix);

  const [prefixWarn, setPrefixWarn] = useState(false);
  const [suffixWarn, setSuffixWarn] = useState(false);

  const handlePrefixChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewPrefix(e.target.value);
  }, []);
  const handleSuffixChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewSuffix(e.target.value);
  }, []);

  const hasChanges = useMemo(
    () =>
      (newPrefix ?? '') !== (currentPrefix ?? '') || (newSuffix ?? '') !== (currentSuffix ?? ''),
    [newPrefix, newSuffix, currentPrefix, currentSuffix]
  );
  const isBlank = useMemo(() => !newPrefix && !newSuffix, [newPrefix, newSuffix]);

  useEffect(() => {
    setPrefixWarn((newPrefix ?? '').endsWith(' '));
    setSuffixWarn((newSuffix ?? '').startsWith(' '));
  }, [newPrefix, newSuffix]);

  const handleSave = () =>
    onSave(id, {
      id: createProxyKey(newPrefix, newSuffix),
      prefix: newPrefix?.trimStart(),
      suffix: newSuffix?.trimEnd(),
    });

  return (
    <SequenceCard
      className={SequenceCardStyle}
      variant="Surface"
      style={{ padding: toRem(8) }}
      gap="100"
    >
      <Box
        direction="Column"
        style={{ width: '100%' }} /* sorry, complex layout, idk what's happening */
      >
        {(prefixWarn || suffixWarn) && (
          <Text size="T200" style={{ color: color.Warning.Main }}>
            Whitespace inside of a shorthand will require whitespace{' '}
            {prefixWarn && suffixWarn
              ? 'before/after'
              : prefixWarn
                ? 'before'
                : suffixWarn
                  ? 'after'
                  : 'before/after'}{' '}
            text to match.
          </Text>
        )}
        <Box direction="Row" gap="100">
          <Input
            value={newPrefix}
            style={{ flexGrow: 1, height: '2rem' }}
            placeholder="Prefix..."
            variant={prefixWarn ? 'Warning' : 'Secondary'}
            radii="300"
            onChange={handlePrefixChange}
          />
          <Input
            value={newSuffix}
            style={{ flexGrow: 1, height: '2rem' }}
            placeholder="Suffix..."
            variant={suffixWarn ? 'Warning' : 'Secondary'}
            radii="300"
            onChange={handleSuffixChange}
          />
          <Box gap="100" style={{ marginLeft: toRem(6) }}>
            <Button
              onClick={() => onDelete(id)}
              size="300"
              variant="Critical"
              disabled={isBlank}
              fill="Soft"
              outlined
              radii="300"
              aria-label="Delete shorthand"
            >
              {deleteState.status === AsyncStatus.Loading ? (
                <Spinner size="100" variant="Primary" fill="Solid" />
              ) : (
                menuIcon(Trash)
              )}
            </Button>
            <Button
              onClick={handleSave}
              size="300"
              variant="Primary"
              disabled={!hasChanges}
              fill="Soft"
              outlined
              radii="300"
              aria-label="Update shorthand"
            >
              {saveState.status === AsyncStatus.Loading ? (
                <Spinner size="100" variant="Primary" fill="Solid" />
              ) : (
                <Text size="B300">Save</Text>
              )}
            </Button>
          </Box>
        </Box>
      </Box>
    </SequenceCard>
  );
}

type ShorthandEditorProps = {
  mx: MatrixClient;
  profileId: string;
};
function ShorthandEditor({ mx, profileId }: ShorthandEditorProps) {
  const [shorthands, setShorthands] = useState<ShorthandRow[]>();

  const containsBlankShorthand = useMemo(
    () => shorthands && shorthands.some((shorthand) => !shorthand.prefix && !shorthand.suffix),
    [shorthands]
  );

  const handleAddShorthand = () => {
    if (shorthands !== undefined) {
      setShorthands([...shorthands, { id: 'blank', rowId: generateShortId(16) }]);
    }
  };

  const [deleteShorthandState, handleDeleteShorthand] = useAsyncCallback(
    useCallback(
      async (id: string) => {
        if (shorthands === undefined) return;

        const shorthandToDelete = shorthands.find((shorthand) => shorthand.id === id);
        if (!shorthandToDelete) return;

        const proxy = constructProxyString(shorthandToDelete);

        await dropProxyAssociationForPMP(mx, proxy);

        setShorthands((s) => s?.filter((shorthand) => shorthand.id !== id));
      },
      [mx, shorthands]
    )
  );

  const [saveShorthandState, handleSaveShorthand] = useAsyncCallback<
    void,
    Error,
    [string, Shorthand]
  >(
    useCallback(
      async (oldId: string, shorthand: Shorthand) => {
        if (shorthands === undefined) return;

        const shorthandAssociation = (await getAllPerMessageProfileProxies(mx)).find(
          (association) => createProxyKey(association.prefix, association.suffix) === shorthand.id
        );
        const shorthandAssociatedProfile = shorthandAssociation
          ? await getPerMessageProfileById(mx, shorthandAssociation.profileId)
          : undefined;
        if (shorthandAssociatedProfile) {
          throw new Error(
            `Shorthand is already associated with profile ${shorthandAssociatedProfile.name} (${shorthandAssociatedProfile.id})`
          );
        }

        if (oldId !== 'blank') {
          await dropProxyAssociationForPMP(mx, oldId);
        }
        await associateProxyWithProfile(mx, profileId, shorthand.prefix, shorthand.suffix, false);

        setShorthands((currentShorthands) => {
          if (currentShorthands === undefined) return currentShorthands;

          const oldShorthandIdx = currentShorthands.findIndex((s) => s.id === oldId);
          if (oldShorthandIdx < 0) return currentShorthands;
          const oldShorthand = currentShorthands[oldShorthandIdx];
          if (oldShorthand === undefined) return currentShorthands;

          return currentShorthands.with(oldShorthandIdx, {
            ...shorthand,
            rowId: oldShorthand.rowId,
          });
        });
      },
      [mx, shorthands, profileId]
    )
  );

  useEffect(() => {
    const fetchShorthands = async () => {
      const fetchedShorthands: PerMessageProfileProxyAssociationV2[] = await getAllProxiesForPMP(
        mx,
        profileId
      );
      const enumeratedShorthands: ShorthandRow[] = fetchedShorthands.map((v) => {
        return { id: createProxyKey(v.prefix, v.suffix), rowId: generateShortId(16), ...v };
      });
      setShorthands(enumeratedShorthands);
    };
    fetchShorthands();
  }, [mx, profileId]);

  return (
    <>
      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="400"
      >
        <SettingTile
          title="Shorthands"
          description="Use this persona for a single message using a prefix or suffix."
          focusId={`shorthandsInput-${profileId}`}
        >
          {saveShorthandState.status === AsyncStatus.Error && (
            <Text size="T200" style={{ color: color.Critical.Main }}>
              {saveShorthandState.error.toString()}
            </Text>
          )}
          {shorthands === undefined ? (
            <Spinner size="400" />
          ) : (
            shorthands.map((shorthand: ShorthandRow) => (
              <ShorthandListItem
                key={shorthand.rowId}
                id={shorthand.id}
                prefix={shorthand.prefix}
                suffix={shorthand.suffix}
                onDelete={handleDeleteShorthand}
                onSave={handleSaveShorthand}
                deleteState={deleteShorthandState}
                saveState={saveShorthandState}
              />
            ))
          )}
          <Button
            onClick={handleAddShorthand}
            size="400"
            radii="300"
            variant="Primary"
            disabled={containsBlankShorthand}
            /* add aria label and title pls */
          >
            <Text size="B300">Add new shorthand</Text>
          </Button>
        </SettingTile>
      </SequenceCard>
    </>
  );
}

/**
 * the props we use for the per-message profile editor, which is used to edit a per-message profile. This is used in the settings page when the user wants to edit a profile.
 */
type PerMessageProfileEditorProps = {
  mx: MatrixClient;
  profileId: string;
  avatarMxcUrl?: string;
  displayName?: string;
  pronouns?: PronounSet[];
  nameColorLightTheme?: string;
  nameColorDarkTheme?: string;
  shorthands?: Shorthand[];
  onDelete?: (profileId: string) => void;
};

export function PerMessageProfileEditor({
  mx,
  profileId,
  avatarMxcUrl,
  displayName,
  pronouns = Array<PronounSet>(),
  nameColorLightTheme,
  nameColorDarkTheme,
  onDelete,
}: Readonly<PerMessageProfileEditorProps>) {
  const useAuthentication = useMediaAuthentication();
  const [currentDisplayName, setCurrentDisplayName] = useState(displayName ?? '');
  const [currentId, setCurrentId] = useState(profileId);
  const [newId, setNewId] = useState(profileId);

  // Pronouns
  const [currentPronouns, setCurrentPronouns] = useState(pronouns);
  const [newPronouns, setNewPronouns] = useState(pronouns);
  const currentPronounsString = useMemo(
    () =>
      Array.isArray(currentPronouns)
        ? currentPronouns.map((p) => `${p.language ? `${p.language}:` : ''}${p.summary}`).join(', ')
        : '',
    [currentPronouns]
  );
  const [newPronounsString, setNewPronounsString] = useState(() => {
    const pronounsString = Array.isArray(newPronouns)
      ? newPronouns.map((p) => `${p.language ? `${p.language}:` : ''}${p.summary}`).join(', ')
      : '';
    return pronounsString;
  });

  // Name color
  const [currentNameColorLight, setCurrentNameColorLight] = useState(nameColorLightTheme ?? null);
  const [newNameColorLight, setNewNameColorLight] = useState(nameColorLightTheme ?? null);
  const [currentNameColorDark, setCurrentNameColorDark] = useState(nameColorDarkTheme ?? null);
  const [newNameColorDark, setNewNameColorDark] = useState(nameColorDarkTheme ?? null);

  const [newDisplayName, setNewDisplayName] = useState(currentDisplayName);
  const [imageFile, setImageFile] = useState<File | undefined>();
  const [imageHasChanges, setImageHasChanges] = useState(false);
  const [avatarMxc, setAvatarMxc] = useState(avatarMxcUrl);
  const imageFileURL = useObjectURL(imageFile);
  const avatarUrl = useMemo(() => {
    if (imageFileURL) return imageFileURL;
    if (avatarMxc) {
      return mxcUrlToHttp(mx, avatarMxc, useAuthentication, 96, 96, 'crop') ?? undefined;
    }
    return undefined;
  }, [imageFileURL, avatarMxc, mx, useAuthentication]);
  const uploadAtom = useMemo(() => {
    if (imageFile) return createUploadAtom(imageFile);
    return undefined;
  }, [imageFile]);
  const pickFile = useFilePicker(setImageFile, false);
  const handleRemoveUpload = useCallback(() => {
    setImageFile(undefined);
    setImageHasChanges(true);
  }, []);
  const handleUploaded = useCallback((upload: { status: string; mxc: string }) => {
    if (upload?.status === 'success') {
      setAvatarMxc(upload.mxc);
      setImageHasChanges(true);
    }
    setImageFile(undefined);
  }, []);
  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewDisplayName(e.target.value);
  }, []);

  const [changingDisplayName, setChangingDisplayName] = useState(false);
  // This state is used to disable the display name input while the user is changing it, to prevent them from making changes while the save operation is in progress.
  // It is set to true when the user clicks the save button, and set back to false when the save operation is complete.
  const [disableSetDisplayname, setDisableSetDisplayname] = useState(false);

  const hasIdChange = useMemo(() => newId !== currentId, [newId, currentId]);

  const hasChanges = useMemo(
    () =>
      newDisplayName !== (currentDisplayName ?? '') ||
      newPronounsString !== currentPronounsString ||
      newNameColorLight !== currentNameColorLight ||
      newNameColorDark !== currentNameColorDark ||
      hasIdChange ||
      imageHasChanges,
    [
      newDisplayName,
      currentDisplayName,
      newPronounsString,
      currentPronounsString,
      newNameColorLight,
      currentNameColorLight,
      newNameColorDark,
      currentNameColorDark,
      hasIdChange,
      imageHasChanges,
    ]
  );

  /**
   * handler for resetting the display name
   */
  const handleDisplayNameReset = useCallback(() => {
    setNewDisplayName(currentDisplayName ?? '');
  }, [currentDisplayName]);

  /**
   * handler for resetting the pronouns
   */
  const handlePronounsReset = useCallback(() => {
    setNewPronouns(currentPronouns);
    setNewPronounsString(currentPronounsString);
  }, [currentPronouns, currentPronounsString]);

  /**
   * persisting the data :3
   */
  const [saveState, handleSave] = useAsyncCallback(
    useCallback(async () => {
      await addOrUpdatePerMessageProfile(mx, {
        id: profileId,
        name: newDisplayName,
        avatarUrl: avatarMxc,
        pronouns: newPronouns,
        colors: {
          on_light: newNameColorLight ?? undefined,
          on_dark: newNameColorDark ?? undefined,
        },
      });

      setCurrentDisplayName(newDisplayName);
      setCurrentPronouns(newPronouns);
      setCurrentNameColorLight(newNameColorLight);
      setCurrentNameColorDark(newNameColorDark);
      setImageHasChanges(false);
      setChangingDisplayName(false);
      setDisableSetDisplayname(false);
      if (hasIdChange) {
        renamePerMessageProfile(mx, profileId, newId).then(() => {
          setCurrentId(newId);
        });
      }
    }, [
      mx,
      profileId,
      newDisplayName,
      avatarMxc,
      newPronouns,
      newNameColorLight,
      newNameColorDark,
      hasIdChange,
      newId,
    ])
  );

  const [deleteState, handleDelete] = useAsyncCallback(
    useCallback(async () => {
      await deletePerMessageProfile(mx, profileId);
      setCurrentDisplayName('');
      setCurrentPronouns([]);
      if (onDelete) onDelete(profileId);
    }, [mx, profileId, onDelete])
  );

  const handleIdChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewId(e.target.value);
  }, []);

  const handlePronounsChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewPronounsString(e.target.value);
    return setNewPronouns(parsePronounsStringToPronounsSetArray(e.target.value));
  }, []);

  return (
    <Box
      direction="Column"
      gap="100"
      role="form"
      aria-labelledby={`profile-editor-title-${profileId}`}
    >
      <Text size="L400">Profile</Text>

      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="400"
      >
        <SettingTile title="Profile ID" focusId={`idInput-${profileId}`}>
          <Box grow="Yes" direction="Column">
            <Input
              required
              name="idInput"
              id={`idInput-${profileId}`}
              value={newId}
              onChange={handleIdChange}
              variant="Secondary"
              radii="300"
              placeholder="Profile ID"
              style={{ paddingRight: config.space.S200 }}
              aria-label="profile id"
              title="profile id"
            />
          </Box>
        </SettingTile>
      </SequenceCard>

      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="400"
      >
        <SettingTile
          title="Avatar"
          focusId={`avatar-${profileId}`}
          after={
            <Avatar size="500" radii="300" aria-label="Profile avatar">
              <UserAvatar
                userId={profileId}
                src={avatarUrl}
                renderFallback={() => (
                  <Text size="H4" aria-label="Avatar fallback">
                    {nameInitials(displayName)}
                  </Text>
                )}
                alt={`Avatar for profile ${profileId}`}
              />
            </Avatar>
          }
        >
          <Box>
            <Button
              onClick={() => pickFile('image/*')}
              size="300"
              variant="Secondary"
              fill="Soft"
              outlined
              radii="300"
              aria-label="Upload avatar image"
            >
              <Text size="T200">Upload</Text>
            </Button>
          </Box>
          {uploadAtom && (
            <Box
              gap="100"
              direction="Column"
              style={{
                width: '100%',
                maxWidth: 100,
                maxHeight: 100,
                overflow: 'visible',
              }}
              aria-label="Upload area"
            >
              <CompactUploadCardRenderer
                uploadAtom={uploadAtom}
                onRemove={handleRemoveUpload}
                onComplete={handleUploaded}
              />
            </Box>
          )}
        </SettingTile>
      </SequenceCard>

      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="400"
      >
        <SettingTile title="Display Name" focusId={`displayNameInput-${profileId}`}>
          <Box grow="Yes" direction="Column">
            <Input
              required
              name="displayNameInput"
              id={`displayNameInput-${profileId}`}
              value={newDisplayName}
              onChange={handleNameChange}
              variant="Secondary"
              radii="300"
              style={{
                paddingRight: config.space.S200,
              }}
              placeholder="Display name"
              readOnly={changingDisplayName || disableSetDisplayname}
              aria-label={`Display name for ${profileId}`}
              title={`Display name for ${profileId}`}
              after={
                newDisplayName !== (currentDisplayName ?? '') &&
                !changingDisplayName && (
                  <IconButton
                    type="reset"
                    onClick={handleDisplayNameReset}
                    size="300"
                    radii="300"
                    variant="Secondary"
                    aria-label="Reset display name"
                    title="Reset display name"
                  >
                    {menuIcon(X)}
                  </IconButton>
                )
              }
            />
          </Box>
        </SettingTile>
      </SequenceCard>

      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="400"
      >
        <SettingTile
          title="Pronouns"
          description="Separate sets with commas"
          focusId={`pronounsInput-${profileId}`}
          after={
            <Input
              required
              name="pronounsInput"
              id={`pronounsInput-${profileId}`}
              value={newPronounsString}
              onChange={handlePronounsChange}
              variant="Secondary"
              radii="300"
              style={{
                paddingRight: config.space.S200,
                width: '232px',
              }}
              placeholder="Add pronouns..."
              readOnly={changingDisplayName || disableSetDisplayname}
              aria-label={`Pronouns for ${profileId}`}
              title={`Pronouns for ${profileId}`}
              after={
                newPronounsString !== currentPronounsString && (
                  <IconButton
                    type="reset"
                    onClick={handlePronounsReset}
                    size="300"
                    radii="300"
                    variant="Secondary"
                    aria-label="Reset pronouns"
                    title="Reset pronouns"
                  >
                    {menuIcon(X)}
                  </IconButton>
                )
              }
            />
          }
        ></SettingTile>
      </SequenceCard>

      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="400"
      >
        <NameColorEditor
          title="Dark theme Name Color"
          description="This persona's name color for a dark theme user."
          focusId={`nameColorDarkTheme-${profileId}`}
          current={currentNameColorDark ?? undefined}
          onChange={setNewNameColorDark}
        />
      </SequenceCard>
      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="400"
      >
        <NameColorEditor
          title="Light theme Name Color"
          description="This persona's name color for a light theme user."
          focusId={`nameColorLightTheme-${profileId}`}
          current={currentNameColorLight ?? undefined}
          onChange={setNewNameColorLight}
        />
      </SequenceCard>
      <Box
        direction="Row"
        alignItems="Center"
        justifyContent="End"
        gap="200"
        aria-label={`Save button area for ${profileId}`}
      >
        <Button
          onClick={handleDelete}
          size="400"
          radii="300"
          variant="Critical"
          disabled={deleteState.status === AsyncStatus.Loading}
          fill="None"
          aria-label={`Delete profile ${profileId}`}
          title={`Delete profile ${profileId}`}
        >
          {deleteState.status === AsyncStatus.Loading ? (
            <Spinner size="100" variant="Critical" fill="Solid" />
          ) : (
            <Text size="B300">Delete persona</Text>
          )}
        </Button>

        <Button
          onClick={handleSave}
          size="400"
          radii="300"
          variant="Primary"
          disabled={!hasChanges || saveState.status === AsyncStatus.Loading}
          aria-label={`Save profile changes for ${profileId}`}
          title={`Save profile changes for ${profileId}`}
        >
          {saveState.status === AsyncStatus.Loading ? (
            <Spinner size="100" variant="Primary" fill="Solid" />
          ) : (
            <Text size="B300">Save</Text>
          )}
        </Button>
      </Box>

      <Text size="L400">Shorthands</Text>
      <ShorthandEditor mx={mx} profileId={profileId} />
    </Box>
  );
}
