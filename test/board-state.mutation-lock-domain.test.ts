import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRedisClient } from '../src/redis/client.js'
import { createBoardMutationLockDomain } from '../src/services/board-state/mutation-lock-domain.js'
import { boardMutationLockKey } from '../src/services/board-state/keys.js'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const BOARD_ID = `board-lock-test-${Date.now()}`

const redisA = createRedisClient(REDIS_URL)
const redisB = createRedisClient(REDIS_URL)
const lockDomainA = createBoardMutationLockDomain(redisA)
const lockDomainB = createBoardMutationLockDomain(redisB)

beforeAll(async () => {
  await redisA.del(boardMutationLockKey(BOARD_ID))
})

afterAll(async () => {
  await redisA.del(boardMutationLockKey(BOARD_ID))
  await redisA.quit()
  await redisB.quit()
})

describe('board mutation lock domain', () => {
  it('serializes access across service instances', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const firstPromise = lockDomainA.withBoardMutationLock(BOARD_ID, async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
    })

    while (!events.includes('first:start')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const secondPromise = lockDomainB.withBoardMutationLock(BOARD_ID, async () => {
      events.push('second:start')
      events.push('second:end')
    })

    const secondStateBeforeRelease = await Promise.race([
      secondPromise.then(() => 'completed'),
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), 75)
      }),
    ])

    expect(secondStateBeforeRelease).toBe('pending')

    releaseFirst()
    await Promise.all([firstPromise, secondPromise])

    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ])
  })
})
