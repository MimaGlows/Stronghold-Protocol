/** Scout and archived prep metadata have no subsequent battle snapshots. */
export function prepSnapshot(field) {
  return { fieldId: field.fieldId, gt: 0, units: (field.units || []).filter((u) => u && u.id != null)
    .map((u) => [u.id, Number(u.x) || 0, Number(u.y) || 0, u.maxHp || 1, u.maxHp || 1, 0, 0, 0, 0]) };
}
