/**
 * Whether the published shared column filters should replace this user's current filters.
 * Followers always track the shared view. A user who switched to personal filters keeps them
 * until somebody publishes a newer shared view than the one current when they opted out.
 */
export function shouldAdoptSharedView(sharedRevision: number, followShared: boolean, optOutRevision: number): boolean {
  return followShared || sharedRevision > optOutRevision;
}
