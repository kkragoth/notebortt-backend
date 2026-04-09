import { describe, expect, it, vi } from 'vitest'
import { createUpgradeHandler } from '../src/ws/upgrade.js'

function createSocketMock() {
  return {
    destroy: vi.fn(),
  } as any
}

describe('createUpgradeHandler', () => {
  it('ignores non-board websocket upgrade paths (for Socket.IO compatibility)', async () => {
    const wss = { handleUpgrade: vi.fn(), emit: vi.fn() } as any
    const authService = { verifyAccessToken: vi.fn() } as any
    const userService = { getUserById: vi.fn() } as any
    const boardService = { checkBoardAccess: vi.fn() } as any
    const handler = createUpgradeHandler(
      wss,
      authService,
      userService,
      boardService,
      'http://localhost:3000',
    )

    const socket = createSocketMock()
    const request = {
      url: '/socket.io/?EIO=4&transport=websocket',
      headers: {
        host: 'localhost:8080',
        origin: 'http://localhost:3000',
      },
    } as any

    await handler(request, socket, Buffer.alloc(0))

    expect(socket.destroy).not.toHaveBeenCalled()
    expect(wss.handleUpgrade).not.toHaveBeenCalled()
    expect(boardService.checkBoardAccess).not.toHaveBeenCalled()
  })
})
