// Current-match continuation delegates to the existing pseudoaccount login and token selection.
// No official sp.matches store, claimAt/noReplace protocol or alternative seat ownership mechanism.
import { doctorProfileKey } from '../../../shared/doctor.js';
export function profileResumeItems(name, room) {
  if (!doctorProfileKey(name)) return [];
  return [{ id: name, name, code: room?.code || '' }];
}
export async function resumeProfile(item, identity, enter) {
  if (!item || !doctorProfileKey(item.name) || item.id !== item.name || identity.loadName() !== item.name) return false;
  await identity.init();
  if (identity.loadName() !== item.name) return false;
  return enter(item.name);
}
