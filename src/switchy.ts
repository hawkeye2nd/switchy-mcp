// Thin client for the Switchy API (https://developers.switchy.io).
// Reads go through the GraphQL endpoint; link create/update go through REST.

export const GRAPHQL_URL = "https://graphql.switchy.io/v1/graphql";
export const REST_BASE = "https://api.switchy.io/v1";

export class SwitchyError extends Error {
  constructor(message: string, public status?: number, public details?: unknown) {
    super(message);
    this.name = "SwitchyError";
  }
}

export interface SwitchyConfig {
  apiToken: string;
  partnerToken?: string;
  timeoutMs?: number;
  graphqlUrl?: string;
  restBase?: string;
}

export class SwitchyClient {
  constructor(private cfg: SwitchyConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Api-Authorization": this.cfg.apiToken,
    };
    if (this.cfg.partnerToken) h["Partner-Authorization"] = this.cfg.partnerToken;
    return h;
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    if (!this.cfg.apiToken) {
      throw new SwitchyError(
        "SWITCHY_API_TOKEN is not configured on the server. Get one in Switchy: workspace Settings → Integrations → Generate a token.",
      );
    }
    const res = await fetch(url, {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? " (check SWITCHY_API_TOKEN — tokens are per workspace: Settings → Integrations → Generate a token)"
          : res.status === 429
            ? " (rate limited — Switchy allows 1,000 links/hour, 10,000/day)"
            : "";
      throw new SwitchyError(`Switchy API ${res.status} ${res.statusText}${hint}`, res.status, body);
    }
    return body;
  }

  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const body = (await this.request(this.cfg.graphqlUrl || GRAPHQL_URL, {
      method: "POST",
      body: JSON.stringify({ query, variables: variables ?? {} }),
    })) as { data?: T; errors?: unknown[] };
    if (body && Array.isArray(body.errors) && body.errors.length) {
      throw new SwitchyError("GraphQL error", undefined, body.errors);
    }
    return body?.data as T;
  }

  createLink(link: Record<string, unknown>, autofill?: boolean): Promise<unknown> {
    const payload: Record<string, unknown> = { link };
    if (autofill !== undefined) payload.autofill = autofill;
    return this.request(`${this.cfg.restBase || REST_BASE}/links/create`, { method: "POST", body: JSON.stringify(payload) });
  }

  updateLink(
    target: { uniqId: string } | { domain: string; id: string },
    link: Record<string, unknown>,
    autofill?: boolean,
  ): Promise<unknown> {
    const path =
      "uniqId" in target
        ? `/links/${encodeURIComponent(target.uniqId)}`
        : `/links/by-domain/${encodeURIComponent(target.domain)}/${encodeURIComponent(target.id)}`;
    const payload: Record<string, unknown> = { link };
    if (autofill !== undefined) payload.autofill = autofill;
    return this.request(`${this.cfg.restBase || REST_BASE}${path}`, { method: "PUT", body: JSON.stringify(payload) });
  }
}
