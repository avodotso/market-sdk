/**
 * Connection config for `MarketClient`. Currently just the Avo API base
 * URL — if/when we add more public endpoints, slot them on the same
 * object so consumers only thread one config through.
 */

export interface AvoServiceConfig {
  /** Base URL of the Avo Portfolio API (e.g. `https://api.avo.so`). No
   *  trailing slash. The client appends paths starting with `/`. */
  avoApi: string;
}

/** Default placeholder — unset. The client throws `SERVICE_UNCONFIGURED`
 *  rather than silently calling a wrong host. Override at construction. */
export const DEFAULT_SERVICE_CONFIG: AvoServiceConfig = {
  avoApi: '',
};

export function resolveServiceConfig(
  partial: Partial<AvoServiceConfig> = {},
): AvoServiceConfig {
  return { ...DEFAULT_SERVICE_CONFIG, ...partial };
}
