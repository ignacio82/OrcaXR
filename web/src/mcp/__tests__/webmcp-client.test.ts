import assert from 'node:assert/strict';
import {
  OrcaWebMcpClient,
  WEBMCP_CLI_PACKAGE,
  WebMcpConnectionError,
  type WebMcpSocket,
  type WebMcpStatus,
} from '../OrcaWebMcpClient';

assert.equal(WEBMCP_CLI_PACKAGE, '@jason.today/webmcp@0.1.13');

class FakeSocket implements WebMcpSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {}

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(data: string): void {
    assert.equal(this.readyState, 1, 'messages can only be sent over an open fake socket');
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function encodeToken(server = 'ws://localhost:4321'): string {
  return btoa(JSON.stringify({ server, token: 'one-use-registration-token' }));
}

function parseSent(socket: FakeSocket, index: number): Record<string, unknown> {
  return JSON.parse(socket.sent[index]) as Record<string, unknown>;
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

{
  const sockets: FakeSocket[] = [];
  const statuses: WebMcpStatus[] = [];
  const errors: Error[] = [];
  const client = new OrcaWebMcpClient({
    pageHost: () => 'orcaxr.example:8443',
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onStatus: (status) => statuses.push({ ...status }),
    onError: (error) => errors.push(error),
  });
  client.registerTool(
    'echo',
    'Echo a value',
    {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    ({ value }) => ({ content: [{ type: 'text', text: String(value) }] }),
  );

  const connecting = client.connect(encodeToken());
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'ws://localhost:4321/register');
  sockets[0].open();

  const registration = JSON.parse(atob(sockets[0].sent[0])) as Record<string, unknown>;
  assert.deepEqual(registration, {
    server: 'ws://localhost:4321',
    token: 'one-use-registration-token',
    host: 'orcaxr_example_8443',
  });

  sockets[0].message({
    type: 'registerSuccess',
    channel: '/orcaxr_example_8443',
    token: 'session token/with symbols',
  });
  await nextTask();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].url, 'ws://localhost:4321/orcaxr_example_8443?token=session+token%2Fwith+symbols');

  const channel = sockets[1];
  channel.open();
  await connecting;
  assert.equal(client.isConnected, true);
  assert.equal(client.status.state, 'connected');
  assert.deepEqual(parseSent(channel, 0), {
    type: 'registerTool',
    name: 'echo',
    description: 'Echo a value',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  });

  channel.message({ type: 'listTools', id: 'list-1' });
  assert.deepEqual(parseSent(channel, 1), {
    id: 'list-1',
    type: 'listToolsResponse',
    tools: [
      {
        name: 'echo',
        description: 'Echo a value',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    ],
  });

  channel.message({ type: 'callTool', id: 7, tool: 'echo', arguments: { value: 'hello' } });
  await nextTask();
  assert.deepEqual(parseSent(channel, 2), {
    id: 7,
    type: 'toolResponse',
    result: { content: [{ type: 'text', text: 'hello' }] },
  });

  channel.message({ type: 'callTool', id: 8, tool: 'missing', arguments: {} });
  await nextTask();
  assert.deepEqual(parseSent(channel, 3), {
    id: 8,
    type: 'toolResponse',
    error: 'Tool not found.',
  });

  channel.message({ type: 'error', message: 'Bridge warning\nwith control text' });
  await nextTask();
  assert.equal(client.isConnected, true, 'a protocol error message does not invent a disconnect');
  assert.equal(client.status.state, 'error');
  assert.equal(errors.at(-1)?.message, 'Bridge warning with control text');

  client.disconnect();
  assert.equal(client.isConnected, false);
  assert.equal(client.status.state, 'disconnected');
  assert.equal(channel.readyState, 3);
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['registering', 'connecting', 'connected', 'error', 'disconnected'],
  );
}

{
  let socketCount = 0;
  const client = new OrcaWebMcpClient({
    pageHost: () => 'localhost:5173',
    socketFactory: (url) => {
      socketCount += 1;
      return new FakeSocket(url);
    },
  });
  await assert.rejects(
    client.connect(encodeToken('wss://bridge.example.com')),
    (error: unknown) =>
      error instanceof WebMcpConnectionError &&
      error.code === 'unsupported_server' &&
      error.message === 'Only a local WebMCP bridge is allowed.',
  );
  assert.equal(socketCount, 0, 'untrusted remote endpoints are rejected before opening a socket');
}

{
  const sockets: FakeSocket[] = [];
  const client = new OrcaWebMcpClient({
    pageHost: () => 'localhost:5173',
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const connecting = client.connect(encodeToken());
  assert.equal(sockets.length, 1);
  client.disconnect('Disabled during registration.');
  await assert.rejects(
    connecting,
    (error: unknown) => error instanceof WebMcpConnectionError && error.code === 'cancelled',
  );
  assert.deepEqual(client.status, { state: 'disconnected', message: 'Disabled during registration.' });
}

console.log('webmcp-client tests passed');
