interface RawElementRow {
  id: string
  type: string
  data: unknown
}

interface PreviewNote {
  x: number
  y: number
  width: number
  height: number
  colorKey: string
}

interface PreviewGrid {
  x: number
  y: number
  width: number
  height: number
  sections: Array<{
    x: number
    y: number
    width: number
    height: number
  }>
}

interface PreviewModel {
  notes: PreviewNote[]
  grids: PreviewGrid[]
}

interface NoteElement {
  id: string
  x: number
  y: number
  color?: string
  width?: number
  customWidth?: number
  computedLayoutHeight?: number
  containerId?: string
  containerColumnId?: string
  containerOrder?: number
}

interface ColumnDef {
  id: string
  col?: number
  row?: number
  colSpan?: number
  rowSpan?: number
  subColumns?: number
}

interface ColumnElement {
  id: string
  x: number
  y: number
  width: number
  height: number
  gridCols?: number
  gridRows?: number
  gridColWidths?: number[]
  gridRowHeights?: number[]
  sections?: ColumnDef[]
  columnDefs?: ColumnDef[]
}

interface TableColumn {
  id: string
  width: number
  colType: string
}

interface TableRow {
  id: string
}

interface TableElement {
  id: string
  x: number
  y: number
  width: number
  height: number
  tableColumns?: TableColumn[]
  tableRows?: TableRow[]
}

const NOTE_COLOR_KEYS = new Set(['amber', 'orange', 'red', 'green', 'emerald', 'teal', 'blue', 'sky', 'purple', 'violet', 'pink', 'gray'])

function normalizeElement(row: RawElementRow): Record<string, unknown> {
  const data = typeof row.data === 'object' && row.data ? row.data as Record<string, unknown> : {}
  return {
    ...data,
    id: row.id,
    kind: row.type,
  }
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id))
}

function calcColumnSections(column: ColumnElement): PreviewGrid['sections'] {
  const gridCols = column.gridCols ?? 1
  const gridRows = column.gridRows ?? 1
  const colWeights = column.gridColWidths ?? Array(gridCols).fill(1)
  const rowWeights = column.gridRowHeights ?? Array(gridRows).fill(1)
  const totalColWeight = colWeights.reduce((sum, value) => sum + value, 0) || 1
  const totalRowWeight = rowWeights.reduce((sum, value) => sum + value, 0) || 1
  const headerHeight = 42
  const bodyY = column.y + headerHeight
  const bodyHeight = Math.max(40, column.height - headerHeight)
  const sections = column.sections ?? column.columnDefs ?? []

  const colStarts: number[] = []
  const rowStarts: number[] = []

  let accX = column.x
  for (let i = 0; i < gridCols; i++) {
    colStarts.push(accX)
    accX += column.width * ((colWeights[i] ?? 1) / totalColWeight)
  }

  let accY = bodyY
  for (let i = 0; i < gridRows; i++) {
    rowStarts.push(accY)
    accY += bodyHeight * ((rowWeights[i] ?? 1) / totalRowWeight)
  }

  return sections.map((section) => {
    const col = section.col ?? 0
    const row = section.row ?? 0
    const colSpan = section.colSpan ?? 1
    const rowSpan = section.rowSpan ?? 1
    const x = colStarts[col] ?? column.x
    const y = rowStarts[row] ?? bodyY
    const right = colStarts[col + colSpan] ?? (column.x + column.width)
    const bottom = rowStarts[row + rowSpan] ?? (bodyY + bodyHeight)
    return {
      x,
      y,
      width: Math.max(1, right - x),
      height: Math.max(1, bottom - y),
    }
  })
}

function layoutContainedNotes(column: ColumnElement, notes: NoteElement[]): PreviewNote[] {
  const sectionsById = new Map<string, ColumnDef>((column.sections ?? column.columnDefs ?? []).map((section) => [section.id, section]))
  const sectionRects = calcColumnSections(column)
  const sectionRectById = new Map((column.sections ?? column.columnDefs ?? []).map((section, index) => [section.id, sectionRects[index]]))
  const grouped = new Map<string, NoteElement[]>()

  for (const note of notes) {
    if (!note.containerColumnId) {
      continue
    }
    if (!grouped.has(note.containerColumnId)) {
      grouped.set(note.containerColumnId, [])
    }
    grouped.get(note.containerColumnId)?.push(note)
  }

  const previewNotes: PreviewNote[] = []

  for (const [targetId, targetNotes] of grouped.entries()) {
    const [sectionId, subIndexRaw] = targetId.split(':')
    const section = sectionsById.get(sectionId)
    const rect = sectionRectById.get(sectionId)
    if (!section || !rect) {
      continue
    }

    const subColumns = section.subColumns ?? 1
    const subIndex = subColumns > 1 ? Number(subIndexRaw ?? 0) : 0
    const subWidth = rect.width / Math.max(1, subColumns)
    const subX = rect.x + subIndex * subWidth
    const ordered = [...targetNotes].sort((a, b) => (a.containerOrder ?? 0) - (b.containerOrder ?? 0))
    let cursorY = rect.y + 24

    for (const note of ordered) {
      const width = Math.max(20, Math.min(subWidth - 8, note.customWidth ?? note.width ?? 160))
      const height = Math.max(26, Math.min(140, note.computedLayoutHeight ?? 74))
      const colorKey = NOTE_COLOR_KEYS.has(note.color ?? '') ? (note.color as string) : 'amber'
      previewNotes.push({
        x: subX + 4,
        y: cursorY,
        width,
        height,
        colorKey,
      })
      cursorY += height + 4
    }
  }

  return previewNotes
}

function calcTableSections(table: TableElement): PreviewGrid['sections'] {
  const columns = table.tableColumns ?? []
  const rows = table.tableRows ?? []
  if (columns.length === 0 || rows.length === 0) {
    return []
  }

  const headerHeight = 40
  const rowHeight = 28
  let colX = table.x + 36
  const colStartMap = new Map<string, number>()
  for (const col of columns) {
    colStartMap.set(col.id, colX)
    colX += col.width
  }

  const sections: PreviewGrid['sections'] = []
  for (const rowIdx of rows.keys()) {
    const y = table.y + headerHeight + rowIdx * rowHeight
    for (const col of columns) {
      sections.push({
        x: colStartMap.get(col.id) ?? table.x,
        y,
        width: Math.max(1, col.width),
        height: rowHeight,
      })
    }
  }
  return sections
}

function layoutTableContainedNotes(table: TableElement, notes: NoteElement[]): PreviewNote[] {
  const columns = table.tableColumns ?? []
  const rows = table.tableRows ?? []
  const noteCols = columns.filter((col) => col.colType === 'NOTE')
  if (noteCols.length === 0 || rows.length === 0) {
    return []
  }

  const colSet = new Set(noteCols.map((col) => col.id))
  const rowSet = new Set(rows.map((row) => row.id))
  const colLeft = new Map<string, number>()
  let accX = table.x + 36
  for (const col of columns) {
    colLeft.set(col.id, accX)
    accX += col.width
  }

  const grouped = new Map<string, NoteElement[]>()
  for (const note of notes) {
    if (!note.containerColumnId) continue
    const [colId, rowId] = note.containerColumnId.split(':')
    if (!colSet.has(colId) || !rowSet.has(rowId)) continue
    const key = `${colId}:${rowId}`
    const current = grouped.get(key) ?? []
    current.push(note)
    grouped.set(key, current)
  }

  const preview: PreviewNote[] = []
  const headerHeight = 40
  const rowHeight = 28
  for (const [key, cellNotes] of grouped.entries()) {
    const [colId, rowId] = key.split(':')
    const col = columns.find((item) => item.id === colId)
    const rowIndex = rows.findIndex((row) => row.id === rowId)
    if (!col || rowIndex < 0) continue
    let cursorY = table.y + headerHeight + rowIndex * rowHeight + 2
    const startX = (colLeft.get(colId) ?? table.x) + 2
    const ordered = [...cellNotes].sort((a, b) => (a.containerOrder ?? 0) - (b.containerOrder ?? 0))
    for (const note of ordered) {
      const width = Math.max(16, Math.min(col.width - 8, note.customWidth ?? note.width ?? 120))
      const height = Math.max(18, Math.min(60, note.computedLayoutHeight ?? 28))
      const colorKey = NOTE_COLOR_KEYS.has(note.color ?? '') ? (note.color as string) : 'amber'
      preview.push({ x: startX, y: cursorY, width, height, colorKey })
      cursorY += height + 2
    }
  }

  return preview
}

function buildBoardPreviewModel(rows: RawElementRow[]): PreviewModel {
  const normalized = rows.map(normalizeElement)
  const notes = sortById(normalized.filter((item) => item.kind === 'NOTE') as unknown as NoteElement[])
  const columns = sortById(normalized.filter((item) => item.kind === 'COLUMN') as unknown as ColumnElement[])
  const tables = sortById(normalized.filter((item) => item.kind === 'TABLE') as unknown as TableElement[])

  const freeNotes = notes
    .filter((note) => !note.containerId)
    .map((note) => {
      const colorKey = note.color ?? 'amber'
      const resolvedColorKey = NOTE_COLOR_KEYS.has(colorKey) ? colorKey : 'amber'
      return {
        x: note.x,
        y: note.y,
        width: note.customWidth ?? note.width ?? 180,
        height: note.computedLayoutHeight ?? 74,
        colorKey: resolvedColorKey,
      }
    })

  const containedNotes = columns.flatMap((column) =>
    layoutContainedNotes(column, notes.filter((note) => note.containerId === column.id)),
  )
  const tableContainedNotes = tables.flatMap((table) =>
    layoutTableContainedNotes(table, notes.filter((note) => note.containerId === table.id)),
  )

  const grids = columns.map((column) => ({
    x: column.x,
    y: column.y,
    width: column.width,
    height: column.height,
    sections: calcColumnSections(column),
  }))
  const tableGrids = tables.map((table) => ({
    x: table.x,
    y: table.y,
    width: table.width,
    height: table.height,
    sections: calcTableSections(table),
  }))

  return {
    notes: [...freeNotes, ...containedNotes, ...tableContainedNotes],
    grids: [...grids, ...tableGrids],
  }
}

function hashString(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function getBoardPreviewVersion(model: PreviewModel): string {
  return hashString(JSON.stringify(model))
}

function renderBoardPreviewSvg(model: PreviewModel, width = 320, height = 200): string {
  const allRects = [
    ...model.grids.map((grid) => ({ x: grid.x, y: grid.y, width: grid.width, height: grid.height })),
    ...model.notes.map((note) => ({ x: note.x, y: note.y, width: note.width, height: note.height })),
  ]

  const minX = allRects.length > 0 ? Math.min(...allRects.map((rect) => rect.x)) : 0
  const minY = allRects.length > 0 ? Math.min(...allRects.map((rect) => rect.y)) : 0
  const maxX = allRects.length > 0 ? Math.max(...allRects.map((rect) => rect.x + rect.width)) : width
  const maxY = allRects.length > 0 ? Math.max(...allRects.map((rect) => rect.y + rect.height)) : height
  const sourceWidth = Math.max(1, maxX - minX + 16)
  const sourceHeight = Math.max(1, maxY - minY + 16)
  const scale = Math.min(width / sourceWidth, height / sourceHeight)
  const offsetX = (width - sourceWidth * scale) / 2
  const offsetY = (height - sourceHeight * scale) / 2
  const tx = offsetX - (minX - 8) * scale
  const ty = offsetY - (minY - 8) * scale

  const gridShapes = model.grids
    .map((grid) => [
      `<rect x="${grid.x}" y="${grid.y}" width="${grid.width}" height="${grid.height}" rx="8" fill="var(--preview-grid-fill)" stroke="var(--preview-grid-stroke)" stroke-width="1.5"/>`,
      ...grid.sections.map((section) =>
        `<rect x="${section.x}" y="${section.y}" width="${section.width}" height="${section.height}" fill="none" stroke="var(--preview-section-stroke)" stroke-width="1"/>`,
      ),
    ].join(''))
    .join('')

  const noteShapes = model.notes
    .map((note) =>
      `<rect x="${note.x}" y="${note.y}" width="${note.width}" height="${note.height}" rx="6" fill="var(--preview-note-${note.colorKey})" stroke="var(--preview-note-stroke)" stroke-width="0.5"/>`,
    )
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="var(--preview-bg)"/><g transform="matrix(${scale} 0 0 ${scale} ${tx} ${ty})">${gridShapes}${noteShapes}</g></svg>`
}

export function createBoardPreviewRenderer() {
  function render(rows: RawElementRow[]): { svg: string; version: string } {
    const model = buildBoardPreviewModel(rows)
    return {
      svg: renderBoardPreviewSvg(model),
      version: getBoardPreviewVersion(model),
    }
  }

  return {
    render,
  }
}

export type BoardPreviewRenderer = ReturnType<typeof createBoardPreviewRenderer>
