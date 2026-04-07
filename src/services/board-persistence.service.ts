import type { BoardStateService } from './board-state.service.js'

export function createBoardPersistenceService(boardStateService: BoardStateService) {
  async function flushDirtyBoards(): Promise<string[]> {
    return boardStateService.persistDirtyBoards()
  }

  function startWorker(intervalMs = 60_000): NodeJS.Timeout {
    return setInterval(async () => {
      try {
        await flushDirtyBoards()
      } catch (error) {
        console.error('[BoardPersistence] flush failed', error)
      }
    }, intervalMs)
  }

  return {
    flushDirtyBoards,
    startWorker,
  }
}

export type BoardPersistenceService = ReturnType<typeof createBoardPersistenceService>
