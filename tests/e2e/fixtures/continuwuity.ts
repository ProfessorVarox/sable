import { GenericContainer, Wait } from 'testcontainers';

const IMAGE = 'ghcr.io/continuwuity/continuwuity:latest';
const CS_PORT = 8008;
const SERVER_NAME = 'test.local';

export type RegisteredUser = {
  userId: string;
  accessToken: string;
  deviceId: string;
};

export type TestHomeserver = {
  baseUrl: string;
  register: (username: string, password: string) => Promise<RegisteredUser>;
  stop: () => Promise<void>;
};

export async function startContinuwuity(): Promise<TestHomeserver> {
  const container = await new GenericContainer(IMAGE)
    .withExposedPorts(CS_PORT)
    .withEnvironment({
      CONTINUWUITY_SERVER_NAME: SERVER_NAME,
      CONTINUWUITY_ADDRESS: '0.0.0.0',
      CONTINUWUITY_PORT: String(CS_PORT),
      CONTINUWUITY_DATABASE_PATH: '/database',
      CONTINUWUITY_ALLOW_REGISTRATION: 'true',
      CONTINUWUITY_YES_I_AM_VERY_VERY_SURE_I_WANT_AN_OPEN_REGISTRATION_SERVER_PRONE_TO_ABUSE:
        'true',
      CONTINUWUITY_FORCE_DISABLE_FIRST_RUN_MODE: 'true',
      CONTINUWUITY_ALLOW_FEDERATION: 'false',
      CONTINUWUITY_ALLOW_CHECK_FOR_UPDATES: 'false',
    })
    .withTmpFs({ '/database': 'rw' })
    .withWaitStrategy(Wait.forHttp('/_matrix/client/versions', CS_PORT).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();

  const baseUrl = `http://${container.getHost()}:${container.getMappedPort(CS_PORT)}`;

  return {
    baseUrl,
    register: (username, password) => registerUser(baseUrl, username, password),
    stop: async () => {
      await container.stop();
    },
  };
}

export async function registerUser(
  baseUrl: string,
  username: string,
  password: string
): Promise<RegisteredUser> {
  const url = `${baseUrl}/_matrix/client/v3/register?kind=user`;
  const probe = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });

  let done = probe;
  if (probe.status === 401) {
    const { session } = (await probe.json()) as { session: string };
    done = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ username, password, auth: { type: 'm.login.dummy', session } }),
    });
  }
  if (!done.ok) {
    throw new Error(`register failed: ${done.status} ${await done.text()}`);
  }
  const body = (await done.json()) as {
    user_id: string;
    access_token: string;
    device_id: string;
  };
  return { userId: body.user_id, accessToken: body.access_token, deviceId: body.device_id };
}

export async function createRoom(
  baseUrl: string,
  token: string,
  body: Record<string, unknown>
): Promise<string> {
  const res = await fetch(`${baseUrl}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`createRoom failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { room_id: string }).room_id;
}

export async function sendText(
  baseUrl: string,
  token: string,
  roomId: string,
  text: string,
  txnId: number
): Promise<void> {
  const url = `${baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ msgtype: 'm.text', body: text }),
  });
  if (!res.ok) {
    throw new Error(`sendText failed: ${res.status} ${await res.text()}`);
  }
}
