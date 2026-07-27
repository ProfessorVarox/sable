import {
  composerIcon,
  MagnifyingGlass,
  menuIcon,
  User as UserIcon,
} from '$components/icons/phosphor';
import { UserAvatar } from '$components/user-avatar/UserAvatar.tsx';
import { useMediaAuthentication } from '$hooks/useMediaAuthentication.ts';
import {
  getCurrentlyUsedPerMessageProfileForRoom,
  getAllPerMessageProfiles,
  type PerMessageProfile,
  setCurrentlyUsedPerMessageProfileIdForRoom,
  getCurrentlyUsedPerMessageProfileForAccount,
  setCurrentlyUsedPerMessageProfileIdForAccount,
} from '$hooks/usePerMessageProfile';
import { stopPropagation } from '$utils/keyboard';
import { mxcUrlToHttp } from '$utils/matrix.ts';
import { isMobileOrTablet } from '$utils/platform';
import FocusTrap from 'focus-trap-react';
import { nameInitials } from '$utils/common';
import {
  Avatar,
  Box,
  config,
  IconButton,
  Input,
  Menu,
  MenuItem,
  PopOut,
  type RectCords,
  Scroll,
  Text,
  toRem,
  Badge,
} from 'folds';
import type { MatrixClient } from 'matrix-js-sdk';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import * as css from './PersonaPicker.css.ts';
import { InfoCard } from '$components/info-card/InfoCard.tsx';
import { InfoIcon } from '@phosphor-icons/react';

export enum PersonaPickerTab {
  Global = 'Global',
  PerRoom = 'PerRoom',
}

type PersonaPickerProps = {
  tab?: PersonaPickerTab;
  mx: MatrixClient;
  roomId: string;
  suppressEditorRefocus: () => void;
  onTabChange: (tab: PersonaPickerTab) => void;
};

export function PersonaPicker({
  tab = PersonaPickerTab.Global,
  mx,
  roomId,
  suppressEditorRefocus,
  onTabChange,
}: PersonaPickerProps) {
  const useAuthentication = useMediaAuthentication();
  const [AddPersonaMenuAnchor, setAddPersonaMenuAnchor] = useState<RectCords>();
  const [profiles, setProfiles] = useState<PerMessageProfile[] | undefined>(undefined);
  const [selectedGlobalPersona, setSelectedGlobalPersona] = useState<PerMessageProfile | null>(
    null
  );
  const [selectedRoomPersona, setSelectedRoomPersona] = useState<PerMessageProfile | null>(null);
  const isPickerMenuItemSelected = (persona: PerMessageProfile) => {
    const selectedPersona =
      tab === PersonaPickerTab.Global ? selectedGlobalPersona : selectedRoomPersona;
    return persona.id === selectedPersona?.id ? true : undefined;
  };

  const defactoPersona = () => selectedRoomPersona ?? selectedGlobalPersona;

  const searchInputRef = useRef<HTMLInputElement>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showPersonaPicker, setShowPersonaPicker] = useState(false);

  const [filteredProfiles, setFilteredProfiles] = useState<PerMessageProfile[] | undefined>(
    undefined
  );

  const clearFilterInput = () => {
    if (searchInputRef.current) {
      searchInputRef.current.value = '';
    }
    setFilteredProfiles(profiles);
  };

  useEffect(() => {
    const syncProfile = async () => {
      const syncedRoomProfile = await getCurrentlyUsedPerMessageProfileForRoom(mx, roomId);
      setSelectedRoomPersona(syncedRoomProfile ?? null);

      const syncedGlobalProfile = await getCurrentlyUsedPerMessageProfileForAccount(mx);
      setSelectedGlobalPersona(syncedGlobalProfile ?? null);
    };
    syncProfile();
  }, [mx, roomId]);

  const fetchProfiles = async (mx_: MatrixClient) => {
    const fetchedProfiles = await getAllPerMessageProfiles(mx_);
    setProfiles(fetchedProfiles);
    setFilteredProfiles(fetchedProfiles);
  };

  useEffect(() => {
    fetchProfiles(mx);
  }, [mx]);

  const filter = (e: FormEvent) => {
    const term = (e.target as HTMLInputElement).value.toLocaleLowerCase();

    const filtered = term
      ? profiles?.filter((profile) =>
          searchInputRef.current
            ? profile.name.toLocaleLowerCase().includes(searchInputRef.current?.value) ||
              profile.id.toLocaleLowerCase().includes(searchInputRef.current?.value)
            : true
        )
      : profiles;

    setFilteredProfiles(filtered);
  };

  const avatarUrl = useCallback(
    (profile: PerMessageProfile) => {
      if (profile.avatarUrl !== undefined) {
        return mxcUrlToHttp(mx, profile.avatarUrl, useAuthentication, 96, 96, 'crop') ?? undefined;
      } else {
        return undefined;
      }
    },
    [mx, useAuthentication]
  );

  return (
    <>
      <PopOut
        anchor={AddPersonaMenuAnchor}
        position="Top"
        align="Start"
        offset={5}
        content={
          <FocusTrap
            focusTrapOptions={{
              initialFocus: false,
              onActivate: () => {
                // HACK: getAllPerMessageProfiles returns [] on Sable first load.
                // BUG: On the third render the list returns empty in testing.
                if (profiles?.length === 0) {
                  fetchProfiles(mx);
                }
              },
              onDeactivate: () => {
                setAddPersonaMenuAnchor(undefined);
                setShowPersonaPicker(false);
                clearFilterInput();
              },
              clickOutsideDeactivates: true,
              escapeDeactivates: stopPropagation,
            }}
          >
            <Menu>
              <Box
                direction="Column"
                gap="100"
                style={{ padding: config.space.S200, minWidth: '18rem' }}
              >
                <Box gap="100">
                  <Badge
                    as="button"
                    variant="Secondary"
                    fill={tab == PersonaPickerTab.Global ? 'Solid' : 'None'}
                    size="500"
                    onClick={() => onTabChange(PersonaPickerTab.Global)}
                  >
                    <Text as="span" size="L400">
                      Global
                    </Text>
                  </Badge>
                  <Badge
                    as="button"
                    variant="Secondary"
                    fill={tab == PersonaPickerTab.PerRoom ? 'Solid' : 'None'}
                    size="500"
                    onClick={() => onTabChange(PersonaPickerTab.PerRoom)}
                  >
                    <Text as="span" size="L400">
                      Per-room
                    </Text>
                  </Badge>
                </Box>

                <>
                  <Input
                    ref={searchInputRef}
                    variant="SurfaceVariant"
                    size="400"
                    placeholder="Search"
                    maxLength={50}
                    autoFocus={!isMobileOrTablet()}
                    onChange={filter}
                    before={menuIcon(MagnifyingGlass)}
                  />

                  <Scroll
                    hideTrack
                    visibility="Hover"
                    ref={scrollRef}
                    size="400"
                    style={{ maxHeight: '10rem', paddingRight: 0 }}
                  >
                    {filteredProfiles?.map((profile) => (
                      <MenuItem
                        key={profile.id}
                        size="400"
                        radii="300"
                        className={css.PersonaPickerMenuItem}
                        aria-selected={isPickerMenuItemSelected(profile)}
                        onClick={async () => {
                          const isGlobal = tab === PersonaPickerTab.Global;
                          const selectedPersona = isGlobal
                            ? selectedGlobalPersona
                            : selectedRoomPersona;
                          const disabling = profile.id === selectedPersona?.id;

                          if (!disabling) {
                            if (isGlobal) {
                              setSelectedGlobalPersona(profile);
                              await setCurrentlyUsedPerMessageProfileIdForAccount(mx, profile.id);
                            } else {
                              setSelectedRoomPersona(profile);
                              await setCurrentlyUsedPerMessageProfileIdForRoom(
                                mx,
                                roomId,
                                profile.id
                              );
                            }
                          } else {
                            if (isGlobal) {
                              setSelectedGlobalPersona(null);
                              await setCurrentlyUsedPerMessageProfileIdForAccount(
                                mx,
                                undefined,
                                undefined,
                                true
                              );
                            } else {
                              setSelectedRoomPersona(null);
                              await setCurrentlyUsedPerMessageProfileIdForRoom(
                                mx,
                                roomId,
                                undefined,
                                undefined,
                                true
                              );
                            }
                          }
                        }}
                        before={
                          <Avatar
                            size="300"
                            radii="400"
                            style={{
                              width: 28,
                              height: 28,
                              marginLeft: -6,
                            }}
                            aria-label="Profile avatar"
                          >
                            <UserAvatar
                              userId={profile.id}
                              src={avatarUrl(profile)}
                              renderFallback={() => (
                                <Text as="span" size="H4" aria-label="Avatar fallback">
                                  {nameInitials(profile.name)}
                                </Text>
                              )}
                              alt={`Avatar for profile ${profile.id}`}
                            />
                          </Avatar>
                        }
                      >
                        <Text truncate style={{ maxWidth: toRem(150) }}>
                          {profile.name}
                        </Text>
                      </MenuItem>
                    ))}
                  </Scroll>
                  <InfoCard
                    before={menuIcon(InfoIcon, { weight: 'fill' })}
                    variant="Primary"
                    description={
                      selectedRoomPersona ? (
                        <>
                          Message will use your <em>per-room</em> persona.
                        </>
                      ) : selectedGlobalPersona ? (
                        <>
                          Message will use your <em>global</em> persona.
                        </>
                      ) : (
                        <>No persona chosen.</>
                      )
                    }
                  />
                </>
              </Box>
            </Menu>
          </FocusTrap>
        }
      />
      {
        <IconButton
          aria-pressed={showPersonaPicker}
          onClick={(evt) => {
            setShowPersonaPicker(true);
            setAddPersonaMenuAnchor(evt.currentTarget.getBoundingClientRect());
          }}
          onPointerDown={suppressEditorRefocus}
          variant="SurfaceVariant"
          size="300"
          style={{ backgroundColor: 'transparent' }}
          title="Switch persona"
          aria-label="Switch persona"
        >
          {(selectedRoomPersona ?? selectedGlobalPersona) ? (
            <Avatar
              size="200"
              radii="300"
              className={
                showPersonaPicker
                  ? css.SelectedPersonaPickerButtonAvatar
                  : css.PersonaPickerButtonAvatar
              }
              aria-label="Profile avatar"
            >
              <UserAvatar
                className={css.PersonaPickerButtonAvatarImage}
                userId={defactoPersona()!.id}
                src={avatarUrl(defactoPersona()!)}
                renderFallback={() => (
                  <Text as="span" size="H6" aria-label="Avatar fallback">
                    {nameInitials(defactoPersona()!.name)}
                  </Text>
                )}
                alt={`Avatar for profile ${defactoPersona()!.id}`}
              />
            </Avatar>
          ) : (
            composerIcon(UserIcon, { weight: showPersonaPicker ? 'fill' : 'regular' })
          )}
        </IconButton>
      }
    </>
  );
}
