import type { RoomParticipant } from './types.js'

export function createParticipantsStore() {
  const roomParticipants = new Map<string, Map<string, RoomParticipant>>()

  function getRoomParticipantMap(boardId: string): Map<string, RoomParticipant> {
    let participants = roomParticipants.get(boardId)
    if (!participants) {
      participants = new Map<string, RoomParticipant>()
      roomParticipants.set(boardId, participants)
    }
    return participants
  }

  function removeParticipant(boardId: string, socketId: string): RoomParticipant | null {
    const participants = roomParticipants.get(boardId)
    if (!participants) {
      return null
    }

    const participant = participants.get(socketId) ?? null
    if (participant) {
      participants.delete(socketId)
    }

    if (participants.size === 0) {
      roomParticipants.delete(boardId)
    }

    return participant
  }

  return {
    getRoomParticipantMap,
    removeParticipant,
  }
}
