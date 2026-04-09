import http from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { io as ioClient, type Socket } from 'socket.io-client'
import * as Y from 'yjs'
import { MutationType } from '../src/mutations/types.js'
import { createSocketIoRealtimeServer } from '../src/socketio/server.js'

interface Harness {
  server: http.Server
  origin: string
  sockets: Socket[]
  mocks: {
    mutationProcessor: { processBatch: ReturnType<typeof vi.fn> }
  }
  close: () => Promise<void>
}

let activeHarness: Harness | null = null

async function createHarness(): Promise<Harness> {
  const server = http.createServer()
  const boardService = {
    checkBoardAccess: vi.fn().mockResolvedValue({ hasAccess: true, permission: 'edit' }),
  }
  const boardStateService = {
    loadBoard: vi.fn().mockResolvedValue(undefined),
    trackClient: vi.fn().mockResolvedValue(undefined),
    touchViewerSession: vi.fn().mockResolvedValue(undefined),
    removeClient: vi.fn().mockResolvedValue(undefined),
    removeViewerSession: vi.fn().mockResolvedValue(undefined),
    getSnapshot: vi.fn().mockResolvedValue({
      elements: { e1: { id: 'e1', kind: 'note', x: 0, y: 0, zIndex: 0, updatedAt: 1 } },
      sequence: 3,
    }),
  }
  const mutationProcessor = {
    processBatch: vi.fn().mockImplementation(async (mutations: any[]) => {
      return mutations.map((mutation, index) => ({
        mutationId: mutation.mutationId,
        status: 'applied',
        sequence: 20 + index,
        serverTimestamp: Date.now(),
        change: {
          sequence: 20 + index,
          serverTimestamp: Date.now(),
          upserts: [],
          deletes: [],
        },
      }))
    }),
  }

  createSocketIoRealtimeServer(server, {
    authService: { verifyAccessToken: vi.fn() } as any,
    userService: { getUserById: vi.fn() } as any,
    boardService: boardService as any,
    boardStateService: boardStateService as any,
    mutationProcessor: mutationProcessor as any,
    pubRedis: { publish: vi.fn().mockResolvedValue(1) } as any,
  }, {
    corsOrigin: 'http://localhost:3000',
    crdtDebounceMs: 30,
    crdtMaxWaitMs: 80,
  })

  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    sockets: [],
    mocks: { mutationProcessor },
    close: async () => {
      for (const socket of activeHarness?.sockets ?? []) {
        if (socket.connected) {
          socket.disconnect()
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function connectSocket(harness: Harness): Promise<Socket> {
  const socket = ioClient(harness.origin, {
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000' },
  })
  harness.sockets.push(socket)
  await once(socket, 'connect')
  return socket
}

afterEach(async () => {
  if (activeHarness) {
    await activeHarness.close()
    activeHarness = null
  }
  vi.restoreAllMocks()
})

describe('createSocketIoRealtimeServer', () => {
  it('joins board, emits snapshot, acks mutation batch, and fanouts mutation', async () => {
    activeHarness = await createHarness()
    const sender = await connectSocket(activeHarness)
    const peer = await connectSocket(activeHarness)

    sender.emit('board:join', { boardId: 'board-1', lastSequence: 0, sessionId: 'session-1' })
    await once(sender, 'board:snapshot')

    peer.emit('board:join', { boardId: 'board-1', lastSequence: 0, sessionId: 'session-2' })
    await once(peer, 'board:snapshot')

    const peerMutationPromise = once(peer, 'mutation')
    const senderAckPromise = once(sender, 'mutation:ack')

    sender.emit('mutation:batch', {
      boardId: 'board-1',
      mutations: [{
        mutationId: 'mut-1',
        boardId: 'board-1',
        clientTimestamp: Date.now(),
        operation: {
          type: MutationType.UPDATE_ELEMENT,
          elementId: 'e1',
          fields: { x: 120, y: 200 },
        },
      }],
    })

    const [ackPayload] = await senderAckPromise
    const [peerPayload] = await peerMutationPromise
    expect(ackPayload.mutationIds).toEqual(['mut-1'])
    expect(peerPayload.mutation.mutationId).toBe('mut-1')
  })

  it('fanouts CRDT updates and persists moves in debounced batch', async () => {
    activeHarness = await createHarness()
    const sender = await connectSocket(activeHarness)
    const peer = await connectSocket(activeHarness)

    sender.emit('board:join', { boardId: 'board-2', lastSequence: 0, sessionId: 'session-a' })
    await once(sender, 'board:snapshot')
    peer.emit('board:join', { boardId: 'board-2', lastSequence: 0, sessionId: 'session-b' })
    await once(peer, 'board:snapshot')

    const yDoc = new Y.Doc()
    yDoc.getMap('moves').set('e1', { x: 42, y: 77 })
    const update = Y.encodeStateAsUpdate(yDoc)

    const peerCrdtPromise = once(peer, 'crdt:update')
    sender.emit('crdt:update', { boardId: 'board-2', update })
    const [crdtPayload] = await peerCrdtPromise
    expect(crdtPayload.boardId).toBe('board-2')

    await new Promise((resolve) => setTimeout(resolve, 130))

    const crdtPersistCalls = activeHarness.mocks.mutationProcessor.processBatch.mock.calls.filter((call) => {
      const firstMutation = call[0]?.[0]
      return firstMutation?.operation?.type === MutationType.MOVE_ELEMENTS
    })
    expect(crdtPersistCalls.length).toBeGreaterThanOrEqual(1)
    expect(crdtPersistCalls[0][0][0].operation.moves[0]).toMatchObject({
      elementId: 'e1',
      x: 42,
      y: 77,
    })
  })
})
