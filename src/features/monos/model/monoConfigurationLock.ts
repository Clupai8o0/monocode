const LOCK_NAME = "monocode:mono-configuration";
const LOCK_UNAVAILABLE = "This window cannot coordinate Mono setup with other windows. Use the Mono settings to configure it manually.";

/** Configuration changes must be serialized across all app windows. */
export async function withMonoConfigurationLock<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks?.request) {
    throw new Error(LOCK_UNAVAILABLE);
  }
  let entered = false;
  try {
    return await navigator.locks.request(LOCK_NAME, () => {
      entered = true;
      return work();
    });
  } catch (error) {
    if (!entered) throw new Error(LOCK_UNAVAILABLE);
    throw error;
  }
}
