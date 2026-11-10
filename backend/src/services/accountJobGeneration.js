// The database serializes job activation against mailbox replacement. Do not turn a
// provenance failure into a generic retry: old work must be reviewed and recreated.
export function accountJobGenerationConflict(err, subject) {
  if (err?.code !== '23514' || !err.message?.startsWith('storage_generation_conflict:')) return null;
  return {
    code: 'storage_generation_conflict',
    error: `This ${subject} belongs to a previous or unverified mailbox. It has not been activated. Review it and create a new one for the current mailbox.`,
  };
}
