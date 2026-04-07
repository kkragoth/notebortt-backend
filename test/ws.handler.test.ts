import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebSocketHandler } from '../src/ws/handler.js'
import { createBoardRoomManager } from '../src/ws/room.js'
import { MutationType } from '../src/mutations/types.js'

class MockWebSocket extends EventEmitter {
  readyState = 1
  sent: string[] = []

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close')
  }
}

class MockRedis extends EventEmitter {
  private static subscribersByChannel = new Map<string, Set<MockRedis>>()
  private subscribedChannels = new Set<string>()

  duplicate(): MockRedis {
    return new MockRedis()
  }

  async publish(channel: string, payload: string): Promise<number> {
    const subscribers = MockRedis.subscribersByChannel.get(channel)
    if (!subscribers || subscribers.size === 0) {
      return 0
    }

    for (const subscriber of subscribers) {
      subscriber.emit('message', channel, payload)
    }

    return subscribers.size
  }

  async subscribe(channel: string): Promise<number> {
    this.subscribedChannels.add(channel)

    const subscribers = MockRedis.subscribersByChannel.get(channel) ?? new Set<MockRedis>()
    subscribers.add(this)
    MockRedis.subscribersByChannel.set(channel, subscribers)

    return subscribers.size
  }

  async unsubscribe(channel: string): Promise<number> {
    this.subscribedChannels.delete(channel)
    const subscribers = MockRedis.subscribersByChannel.get(channel)

    if (!subscribers) {
      return 0
    }

    subscribers.delete(this)
    if (subscribers.size === 0) {
      MockRedis.subscribersByChannel.delete(channel)
      return 0
    }

    return subscribers.size
  }

  async get(_key: string): Promise<string | null> {
    return null
  }

  static reset(): void {
    MockRedis.subscribersByChannel.clear()
  }
}

function makeRequest(boardId: string, sessionId: string): IncomingMessage {
  return {
    __wsContext: {
      boardId,
      userId: `${sessionId}-user`,
      userName: `User ${sessionId}`,
      avatarUrl: null,
      lastSequence: 0,
      sessionId,
    },
  } as any
}

function decodeMessages(messages: string[]): any[] {
  return messages.map((message) => JSON.parse(message))
}

function createBoardStateServiceMock(viewerCount = 0) {
  const base = {
    loadBoard: vi.fn().mockResolvedValue(0),
    trackClient: vi.fn().mockResolvedValue(undefined),
    touchViewerSession: vi.fn().mockResolvedValue(undefined),
    removeClient: vi.fn().mockResolvedValue(undefined),
    removeViewerSession: vi.fn().mockResolvedValue(undefined),
    getClientCount: vi.fn().mockResolvedValue(0),
    getActiveViewerCount: vi.fn().mockResolvedValue(viewerCount),
    persistBoard: vi.fn().mockResolvedValue(undefined),
    flushBoard: vi.fn().mockResolvedValue(undefined),
    getSnapshot: vi.fn().mockResolvedValue({ elements: {}, sequence: 0 }),
    getElements: vi.fn().mockResolvedValue({}),
    getChangesAfter: vi.fn().mockResolvedValue({ changes: [], complete: true }),
  }

  return base as any
}

function createHandler(viewerCount = 0) {
  const roomManager = createBoardRoomManager()
  const boardStateService = createBoardStateServiceMock(viewerCount)
  const mutationProcessor = {
    processBatch: vi.fn().mockImplementation(async (mutations: any[]) => {
      return mutations.map((mutation, index) => ({
        mutationId: mutation.mutationId,
        status: 'applied' as const,
        serverTimestamp: 123 + index,
        sequence: 1 + index,
        change: {
          sequence: 1 + index,
          serverTimestamp: 123 + index,
          upserts: [],
          deletes: [],
        },
      }))
    }),
  } as any
  const heartbeat = {
    handlePong: vi.fn(),
    handleActivity: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
  } as any
  const pubRedis = new MockRedis() as any

  return {
    roomManager,
    boardStateService,
    mutationProcessor,
    heartbeat,
    pubRedis,
    handler: createWebSocketHandler(roomManager, boardStateService, mutationProcessor, heartbeat, pubRedis),
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function waitForBatchWindow(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  MockRedis.reset()
})

describe('createWebSocketHandler', () => {
  it('delivers ELEMENTS_CHANGED to local peers once through pubsub fanout', async () => {
    const { handler } = createHandler()
    const boardId = 'board-local-fanout'
    const sender = new MockWebSocket()
    const peer = new MockWebSocket()

    await handler.onConnection(sender as any, makeRequest(boardId, 'session-a'))
    await handler.onConnection(peer as any, makeRequest(boardId, 'session-b'))

    const senderSentBefore = sender.sent.length
    const peerSentBefore = peer.sent.length

    sender.emit(
      'message',
      Buffer.from(JSON.stringify({
        type: 'MUTATION',
        mutation: {
          mutationId: 'mut-1',
          boardId,
          clientTimestamp: 123,
          operation: {
            type: MutationType.UPDATE_ELEMENT,
            elementId: 'element-1',
            fields: { x: 12 },
          },
        },
      })),
    )

    await flushMicrotasks()
    await waitForBatchWindow()
    await flushMicrotasks()

    const senderAfter = decodeMessages(sender.sent.slice(senderSentBefore))
    const peerAfter = decodeMessages(peer.sent.slice(peerSentBefore))

    expect(senderAfter.filter((message) => message.type === 'ELEMENTS_CHANGED')).toHaveLength(0)
    expect(senderAfter.filter((message) => message.type === 'MUTATION_RESULT')).toHaveLength(1)
    expect(peerAfter.filter((message) => message.type === 'ELEMENTS_CHANGED')).toHaveLength(1)
    expect(peerAfter.filter((message) => message.type === 'ELEMENTS_CHANGED')[0]).toMatchObject({
      type: 'ELEMENTS_CHANGED',
      fromUserId: 'session-a-user',
    })
  })

  it('does not flush while Redis still reports active viewers', async () => {
    vi.useFakeTimers()

    const { handler, boardStateService } = createHandler(1)
    const boardId = 'board-global-idle-check'
    const ws = new MockWebSocket()

    await handler.onConnection(ws as any, makeRequest(boardId, 'session-a'))
    ws.close()

    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(30_000)
    await flushMicrotasks()

    expect(boardStateService.getClientCount).toHaveBeenCalledWith(boardId)
    expect(boardStateService.getActiveViewerCount).toHaveBeenCalledWith(boardId)
    expect(boardStateService.flushBoard).not.toHaveBeenCalled()
  })

  it('fanouts ELEMENTS_CHANGED once to peers on another instance via pubsub', async () => {
    const boardId = 'board-cross-instance-fanout'
    const sharedRedis = new MockRedis() as any

    const instanceA = createHandler()
    const instanceB = createHandler()
    const handlerA = createWebSocketHandler(
      instanceA.roomManager,
      instanceA.boardStateService,
      instanceA.mutationProcessor,
      instanceA.heartbeat,
      sharedRedis,
    )
    const handlerB = createWebSocketHandler(
      instanceB.roomManager,
      instanceB.boardStateService,
      instanceB.mutationProcessor,
      instanceB.heartbeat,
      sharedRedis,
    )

    const sender = new MockWebSocket()
    const remotePeer = new MockWebSocket()

    await handlerA.onConnection(sender as any, makeRequest(boardId, 'session-a'))
    await handlerB.onConnection(remotePeer as any, makeRequest(boardId, 'session-b'))

    const remoteSentBefore = remotePeer.sent.length
    sender.emit(
      'message',
      Buffer.from(JSON.stringify({
        type: 'MUTATION',
        mutation: {
          mutationId: 'mut-x-instance',
          boardId,
          clientTimestamp: 123,
          operation: {
            type: MutationType.UPDATE_ELEMENT,
            elementId: 'element-1',
            fields: { x: 45 },
          },
        },
      })),
    )

    await flushMicrotasks()
    await waitForBatchWindow()
    await flushMicrotasks()

    const remoteAfter = decodeMessages(remotePeer.sent.slice(remoteSentBefore))
    expect(remoteAfter.filter((message) => message.type === 'ELEMENTS_CHANGED')).toHaveLength(1)
    expect(remoteAfter[0]).toMatchObject({
      type: 'ELEMENTS_CHANGED',
      fromUserId: 'session-a-user',
    })
  })

  it('micro-batches quick mutation bursts into one processor batch', async () => {
    const { handler, mutationProcessor } = createHandler()
    const boardId = 'board-micro-batch'
    const ws = new MockWebSocket()

    await handler.onConnection(ws as any, makeRequest(boardId, 'session-a'))

    const payloads = ['mut-1', 'mut-2', 'mut-3'].map((mutationId) =>
      Buffer.from(JSON.stringify({
        type: 'MUTATION',
        mutation: {
          mutationId,
          boardId,
          clientTimestamp: Date.now(),
          operation: {
            type: MutationType.UPDATE_ELEMENT,
            elementId: `el-${mutationId}`,
            fields: { x: 10 },
          },
        },
      })),
    )

    for (const payload of payloads) {
      ws.emit('message', payload)
    }

    await flushMicrotasks()
    await waitForBatchWindow()
    await flushMicrotasks()

    expect(mutationProcessor.processBatch).toHaveBeenCalledTimes(1)
    expect(mutationProcessor.processBatch.mock.calls[0][0]).toHaveLength(3)

    const results = decodeMessages(ws.sent).filter((message) => message.type === 'MUTATION_RESULT')
    expect(results).toHaveLength(3)
  })
})
