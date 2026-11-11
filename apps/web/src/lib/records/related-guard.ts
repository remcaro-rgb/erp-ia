// The tab «Documentos relacionados» is supplementary (Task 31, design §22.27): whatever goes wrong while loading it (a SQL error in the
// trail, a step-up the admin required of the process, a timeout, a title that cannot be resolved) is logged on the server and the record
// page renders without the tab. Kept apart from the loader (which is server-only) so the isolation is unit-tested.

export async function guardRelated<T>(load: () => Promise<T | null>, log: (message: string, error: unknown) => void = (message, error) => console.error(message, error)): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    log("related documents: the trail could not be loaded, the record page renders without the tab", error);
    return null;
  }
}
