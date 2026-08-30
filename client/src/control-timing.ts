export const togglRequestDeadlineMilliseconds = 10_000;

export const maximumInteractiveTogglRequests = 4;
export const maximumBlockingBackgroundTogglRequests = 1;
const localResponseGraceMilliseconds = 5_000;

export const commandResponseTimeoutMilliseconds =
  togglRequestDeadlineMilliseconds *
    (maximumInteractiveTogglRequests + maximumBlockingBackgroundTogglRequests) +
  localResponseGraceMilliseconds;
