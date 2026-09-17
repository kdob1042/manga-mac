// Migration only: never interpret the obsolete boundary as an editing constraint.
export function removeLegacyConfirmation(state) {
  delete state.confirmedThroughPanelId;
  for (const key of ['history','editRedo']) for (const entry of state[key] ?? []) removeLegacyConfirmation(entry);
  if (state.after) removeLegacyConfirmation(state.after);
  return state;
}
