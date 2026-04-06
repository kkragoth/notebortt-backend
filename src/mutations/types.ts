export enum MutationType {
  CREATE_ELEMENT = 'CREATE_ELEMENT',
  UPDATE_ELEMENT = 'UPDATE_ELEMENT',
  DELETE_ELEMENTS = 'DELETE_ELEMENTS',
  MOVE_ELEMENTS = 'MOVE_ELEMENTS',
  UPDATE_ELEMENTS = 'UPDATE_ELEMENTS',
  REORDER_ELEMENT = 'REORDER_ELEMENT',
}

export interface BoardElement {
  id: string
  kind: string
  x: number
  y: number
  zIndex: number
  updatedAt: number
  [key: string]: unknown
}

export type Operation =
  | { type: MutationType.CREATE_ELEMENT; elementId: string; data: BoardElement }
  | { type: MutationType.UPDATE_ELEMENT; elementId: string; fields: Partial<BoardElement> }
  | { type: MutationType.DELETE_ELEMENTS; elementIds: string[] }
  | { type: MutationType.MOVE_ELEMENTS; moves: Array<{ elementId: string; x: number; y: number }>; transient?: boolean }
  | { type: MutationType.UPDATE_ELEMENTS; updates: Array<{ elementId: string; fields: Partial<BoardElement> }> }
  | { type: MutationType.REORDER_ELEMENT; elementId: string; zIndex: number }

export interface Mutation {
  mutationId: string
  boardId: string
  clientTimestamp: number
  serverTimestamp?: number
  sequence?: number
  operation: Operation
}

export interface MutationResult {
  mutationId: string
  status: 'applied' | 'already_applied' | 'broadcast_only'
  serverTimestamp?: number
  sequence?: number
}
