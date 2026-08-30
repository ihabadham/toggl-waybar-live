export const togglRequestDeadlineMilliseconds = 10_000;

export const maximumInteractiveTogglRequests = 4;
const localResponseGraceMilliseconds = 5_000;

export const commandResponseTimeoutMilliseconds =
  togglRequestDeadlineMilliseconds * maximumInteractiveTogglRequests +
  localResponseGraceMilliseconds;
