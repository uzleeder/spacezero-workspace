'use strict';
const OMIT = new Set(['Session', 'Invitation', 'PasswordResetToken', 'RateLimitAttempt']);
// Cross-model circular references (not self-refs, which are already excluded below): the
// import script inserts the row with this FK null and backfills it once both sides exist.
// Keyed by "Model.relationFieldName" (the object-kind field, not the scalar *Id column).
const DEFERRED_FIELDS = new Set(['StandardsItem.currentVersion']);
function importModels(metadata) {
  const pending = metadata.filter(m => !OMIT.has(m.name));
  const ordered = [];
  while (pending.length) {
    const index = pending.findIndex(m => m.fields.filter(f => f.kind === 'object' && f.relationFromFields?.length && f.type !== m.name && !DEFERRED_FIELDS.has(`${m.name}.${f.name}`)).every(f => ordered.some(x => x.name === f.type)));
    if (index < 0) throw new Error('Import dependency cycle or excluded referenced model. Review schema before importing.');
    ordered.push(pending.splice(index, 1)[0]);
  }
  return ordered.map(m => m.name[0].toLowerCase() + m.name.slice(1));
}
module.exports = { importModels, OMIT, DEFERRED_FIELDS };
