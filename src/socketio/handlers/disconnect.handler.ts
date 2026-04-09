import type { SocketIoHandlerRuntime } from './runtime.js'

export function createDisconnectHandler(
  runtime: SocketIoHandlerRuntime,
  cleanupConnectionState: () => void,
) {
  return async (): Promise<void> => {
    const context = runtime.getBoardContext()
    if (!context) {
      cleanupConnectionState()
      return
    }

    runtime.setBoardContext(null)
    await runtime.detachFromBoard(context, true)
    cleanupConnectionState()
  }
}
