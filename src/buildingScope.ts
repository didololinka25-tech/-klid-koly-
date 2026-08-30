export type BuildingScoped = { buildingId?: string | null }

export function forBuilding<T extends BuildingScoped>(items: T[], buildingId: string) {
  return items.filter((item) => item.buildingId === buildingId)
}

export function roomForBuilding<T extends { id: string; buildingId: string }>(
  rooms: T[],
  roomId: string | null | undefined,
  buildingId: string,
) {
  if (!roomId) return null
  return rooms.some((room) => room.id === roomId && room.buildingId === buildingId) ? roomId : null
}

export function attendanceStartValues(
  workerId: string,
  buildingId: string,
  startedAt: string,
  attendanceDate: string,
) {
  if (!buildingId) throw new Error('Vyberte pracoviště směny.')
  return { worker_id: workerId, building_id: buildingId, started_at: startedAt, attendance_date: attendanceDate }
}
