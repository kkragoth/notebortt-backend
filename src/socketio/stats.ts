let openSocketIoConnections = 0

export function incrementOpenSocketIoConnections(): void {
  openSocketIoConnections += 1
}

export function decrementOpenSocketIoConnections(): void {
  openSocketIoConnections = Math.max(0, openSocketIoConnections - 1)
}

export function getOpenSocketIoConnections(): number {
  return openSocketIoConnections
}

export function resetOpenSocketIoConnectionsForTests(): void {
  openSocketIoConnections = 0
}
