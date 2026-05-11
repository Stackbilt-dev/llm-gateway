type CloudflareRunInput = Record<string, unknown>;

interface CloudflareAiBindingOptions {
  accountId: string;
  apiToken: string;
  apiBaseUrl?: string;
}

interface CloudflareAiBinding {
  run(model: string, input: CloudflareRunInput): Promise<unknown>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function createCloudflareAiBinding(options: CloudflareAiBindingOptions): CloudflareAiBinding {
  const baseUrl = trimTrailingSlash(options.apiBaseUrl ?? "https://api.cloudflare.com/client/v4");
  const accountId = options.accountId.trim();
  const apiToken = options.apiToken.trim();

  return {
    async run(model: string, input: CloudflareRunInput): Promise<unknown> {
      const encodedModel = encodeURIComponent(model);
      const url = `${baseUrl}/accounts/${accountId}/ai/run/${encodedModel}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });

      const payload = (await response.json().catch(() => null)) as
        | { success?: boolean; errors?: Array<{ message?: string }> | null; result?: unknown }
        | null;

      if (!response.ok || !payload?.success) {
        const firstError = payload?.errors?.[0]?.message;
        const message = firstError ?? `Cloudflare AI request failed (${response.status})`;
        throw new Error(message);
      }

      return payload.result;
    },
  };
}
