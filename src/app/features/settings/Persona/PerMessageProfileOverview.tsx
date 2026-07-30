import { useMatrixClient } from '$hooks/useMatrixClient';
import type { PerMessageProfile } from '$hooks/usePerMessageProfile';
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

type PerMessageProfileOverviewProps = {
  onCreateProfile: (profile: PerMessageProfile) => void;
  onEditProfile: (profile: PerMessageProfile) => void;
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
  const [profiles, setProfiles] = useState<PerMessageProfile[]>([]);

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
      const newProfile: PerMessageProfile = {
        id: generateShortId(5),
        name: 'New Profile',
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
            profileId={profile.id}
            avatarMxcUrl={profile.avatarUrl}
            displayName={profile.name}
            pronouns={profile.pronouns}
            onOpenEditor={handleEdit}
          />
        </SequenceCard>
      ))}
    </Box>
  );
}
