import core from '../public/core.js';

// Company reference data is retained; identities, activity and appeals start empty.
export function createProductionState() {
  const state = core.emptyState();
  state.users = [{ id: 'o1', name: 'Собственник', role: 'owner', jobTitle: 'Собственник' }];
  state.departments = [];
  state.categories = state.categories.map(category => ({ ...category, owner: 'o1', backup: 'o1', ...(category.praiseOwner ? { praiseOwner: 'o1' } : {}) }));
  state.settings.fallbackUser = 'o1';
  state.settings.ownerTriage = true;
  state.settings.production = true;
  core.saveEntry(state, 'o1', null, { name: 'Сайт компании', kind: 'site' });
  core.saveEntry(state, 'o1', null, { name: 'Офис, вход', kind: 'office' });
  // ensureDefaults only inserts demo links into a completely empty entries list.
  core.ensureDefaults(state);
  return state;
}
