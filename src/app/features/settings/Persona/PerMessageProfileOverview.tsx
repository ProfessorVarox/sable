import { useMatrixClient } from '$hooks/useMatrixClient';
import type { PerMessageProfileMsc4461 } from '$hooks/usePerMessageProfile';
import {
  addOrUpdatePerMessageProfile,
  getAllPerMessageProfiles,
  getPerMessageProfileById,
} from '$hooks/usePerMessageProfile';
import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Spinner, Text } from 'folds';
import { generateShortId } from '$utils/shortIdGen';
import { SequenceCard, SequenceCardStyle } from '$components/sequence-card';
import { PerMessageProfileListItem } from './PerMessageProfileListItem';
import { SettingTile } from '$components/setting-tile';
import { AsyncStatus, useAsyncCallback } from '$hooks/useAsyncCallback';
import {
  MATRIX_UNSTABLE_COLORS,
  MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME,
} from '$unstable/prefixes';

type PerMessageProfileOverviewProps = {
  onCreateProfile: (profile: PerMessageProfileMsc4461) => void;
  onEditProfile: (profile: PerMessageProfileMsc4461) => void;
};
/**
 * Renders a list of per-message profiles along with an editor.
 * @returns rendering of per message profile list including editor
 */
export function PerMessageProfileOverview({
  onCreateProfile,
  onEditProfile,
}: PerMessageProfileOverviewProps) {
  const mx = useMatrixClient();
  const [profiles, setProfiles] = useState<PerMessageProfileMsc4461[]>([]);

  useEffect(() => {
    const fetchProfiles = async () => {
      const fetchedProfiles = await getAllPerMessageProfiles(mx);
      setProfiles(fetchedProfiles);
    };
    fetchProfiles();
  }, [mx]);

  const handleEdit = async (profileId: string) => {
    const profile = await getPerMessageProfileById(mx, profileId);
    if (profile) onEditProfile(profile);
  };

  const [addState, handleAdd] = useAsyncCallback(
    useCallback(async () => {
      const newProfile: PerMessageProfileMsc4461 = {
        id: generateShortId(5),
        displayname: 'New Profile',
        trigger: { prefix: [] },
      };
      await addOrUpdatePerMessageProfile(mx, newProfile);
      onCreateProfile(newProfile);
    }, [mx, onCreateProfile])
  );

  return (
    <Box gap="100" direction="Column">
      <Text size="L400">Personas</Text>

      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="100"
      >
        <SettingTile
          focusId="create-pmp"
          title="Create Persona"
          description="Create Personas to attach custom profiles to messages."
          after={
            <Button
              size="300"
              radii="300"
              onClick={handleAdd}
              disabled={addState.status === AsyncStatus.Loading}
            >
              {addState.status === AsyncStatus.Loading ? (
                <Spinner size="100" variant="Primary" fill="Solid" />
              ) : (
                <Text size="B300">Add</Text>
              )}
            </Button>
          }
        />
      </SequenceCard>

      {profiles.map((profile) => (
        <SequenceCard
          className={SequenceCardStyle}
          variant="SurfaceVariant"
          direction="Column"
          key={`profile-list-item-${profile.id}`}
        >
          <PerMessageProfileListItem
            mx={mx}
            avatarMxcUrl={profile.avatar_url}
            displayName={profile.displayname}
            pronouns={profile[MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME]}
            profileId={profile.id}
            nameColorLight={profile[MATRIX_UNSTABLE_COLORS]?.on_light}
            nameColorDark={profile[MATRIX_UNSTABLE_COLORS]?.on_dark}
            onOpenEditor={handleEdit}
          />
        </SequenceCard>
      ))}
    </Box>
  );
}
