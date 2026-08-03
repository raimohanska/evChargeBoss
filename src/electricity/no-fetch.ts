export const NO_FETCH_ENV = "EVCHARGEBOSS_NO_FETCH";

/**
 * Throw when a network fetch would be made while `EVCHARGEBOSS_NO_FETCH` is
 * set.  Every test file sets it so tests fail loudly instead of spending the
 * spot/solar API rate-limit budget.  Read at call time (not module load) so
 * tests may set it at the top of the file, and `test/forecast-influx.test.ts`
 * may lift it around a strictly mocked fetch.
 */
export function assertNetworkFetchAllowed(what: string): void {
  if (process.env[NO_FETCH_ENV]) {
    throw new Error(
      `Offline guard: fetching ${what} needs the network but ${NO_FETCH_ENV} is set. ` +
        `Add the missing cache fixture instead of allowing a real fetch.`,
    );
  }
}
