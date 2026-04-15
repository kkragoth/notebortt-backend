import { randomUUID } from 'crypto'
import type Redis from 'ioredis'
import {
  BOARD_MUTATION_LOCK_POLL_MS,
  BOARD_MUTATION_LOCK_TTL_MS,
  boardMutationLockKey,
  sleep,
} from './keys.js'

export function createBoardMutationLockDomain(redis: Redis) {
  const localLocks = new Map<string, Promise<void>>()

  async function withLocalLock<T>(boardId: string, task: () => Promise<T>): Promise<T> {
    const previous = localLocks.get(boardId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })

    localLocks.set(boardId, previous.then(() => current))
    await previous

    try {
      return await task()
    } finally {
      release()
      if (localLocks.get(boardId) === current) {
        localLocks.delete(boardId)
      }
    }
  }

  async function acquireMutationLock(boardId: string): Promise<string> {
    while (true) {
      const token = randomUUID()
      const acquired = await redis.set(
        boardMutationLockKey(boardId),
        token,
        'PX',
        BOARD_MUTATION_LOCK_TTL_MS,
        'NX',
      )

      if (acquired === 'OK') {
        return token
      }

      await sleep(BOARD_MUTATION_LOCK_POLL_MS)
    }
  }

  async function extendMutationLock(boardId: string, token: string): Promise<void> {
    await redis.eval(
      `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('pexpire', KEYS[1], ARGV[2])
        end

        return 0
      `,
      1,
      boardMutationLockKey(boardId),
      token,
      BOARD_MUTATION_LOCK_TTL_MS.toString(),
    )
  }

  async function releaseMutationLock(boardId: string, token: string): Promise<void> {
    await redis.eval(
      `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        end

        return 0
      `,
      1,
      boardMutationLockKey(boardId),
      token,
    )
  }

  async function withBoardMutationLock<T>(boardId: string, task: () => Promise<T>): Promise<T> {
    return withLocalLock(boardId, async () => {
      const token = await acquireMutationLock(boardId)
      const renewHandle = setInterval(() => {
        void extendMutationLock(boardId, token)
      }, Math.max(250, Math.floor(BOARD_MUTATION_LOCK_TTL_MS / 3)))
      renewHandle.unref?.()

      try {
        return await task()
      } finally {
        clearInterval(renewHandle)
        await releaseMutationLock(boardId, token)
      }
    })
  }

  return { withBoardMutationLock }
}

export type BoardMutationLockDomain = ReturnType<typeof createBoardMutationLockDomain>
