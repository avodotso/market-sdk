/**
 * HTTP plumbing shared by `MarketClient`. Owns:
 *
 *   • Config resolution (the `AvoServiceConfig` slot is required when
 *     making any call; an unset base URL throws `SERVICE_UNCONFIGURED`).
 *   • `requestService(...)` — typed JSON request with consistent error
 *     parsing (`AvoSdkError`) + transport-failure handling
 *     (`AvoTransportError`).
 *   • URL assembly from base + path + query record.
 *
 * No service-specific methods live here. Subclassed by `MarketClient`.
 */
import { AvoSdkError, AvoTransportError, type ServiceErrorBody } from './errors';
import {
  type AvoServiceConfig,
  resolveServiceConfig,
} from './config';

export interface HttpBaseConfig {
  /** Partial service-URL overrides; missing fields stay empty. */
  services?: Partial<AvoServiceConfig>;
  /** Custom fetch (testing / instrumentation). Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

export class HttpBase {
  protected readonly services: AvoServiceConfig;
  protected readonly fetchImpl: typeof fetch;

  constructor(cfg: HttpBaseConfig = {}) {
    this.services = resolveServiceConfig(cfg.services);
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  /**
   * Generic typed-JSON request against the Avo API. Handles:
   *   • non-2xx responses → `AvoSdkError` with code/message lifted from the
   *     service's error envelope when present
   *   • fetch failures + non-JSON bodies → `AvoTransportError`
   *   • optional extra request headers (Sig / Bearer auth)
   *   • query string assembly from a record of primitive/undefined values
   */
  protected async requestService<T>(opts: {
    baseUrl: string | undefined;
    method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    query?: Record<string, string | number | boolean | undefined>;
  }): Promise<T> {
    if (!opts.baseUrl) {
      throw new AvoSdkError({
        status: 500,
        code: 'SERVICE_UNCONFIGURED',
        message:
          'Cannot call avo-api — no `services.avoApi` URL configured. ' +
          'Pass one to the client constructor.',
      });
    }

    const headers: Record<string, string> = {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    };

    const url = buildUrl(opts.baseUrl, opts.path, opts.query);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      throw new AvoTransportError(
        `avo-api: network failure for ${opts.method} ${opts.path}: ${(err as Error).message}`,
        err,
      );
    }

    if (!res.ok) {
      let parsed: ServiceErrorBody | { code?: string; message?: string; details?: unknown } | null = null;
      try {
        parsed = (await res.json()) as ServiceErrorBody | { code?: string; message?: string; details?: unknown };
      } catch {
        // non-JSON body
      }
      const envelope =
        parsed && 'error' in parsed && parsed.error
          ? parsed.error
          : (parsed as { code?: string; message?: string; details?: unknown } | null);
      throw new AvoSdkError({
        status: res.status,
        code: envelope?.code ?? `HTTP_${res.status}`,
        message:
          envelope?.message ??
          `avo-api returned ${res.status} ${res.statusText} for ${opts.method} ${opts.path}`,
        details: envelope?.details,
      });
    }

    if (res.status === 204) {
      return undefined as unknown as T;
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new AvoTransportError(
        `avo-api: ${opts.method} ${opts.path} returned non-JSON response`,
        err,
      );
    }
  }
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const base = baseUrl.replace(/\/$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  if (!query) return `${base}${p}`;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${base}${p}?${s}` : `${base}${p}`;
}
