import { GatewayRequestContext, LLMRequest, LLMResponse } from "../types.js";

export interface ClientAdapter<ClientRequest, ClientResponse> {
  toLLMRequest(input: ClientRequest, context: GatewayRequestContext): LLMRequest;
  fromLLMResponse(output: LLMResponse, context: GatewayRequestContext): ClientResponse;
  fromLLMStream?(
    stream: ReadableStream<string>,
    context: GatewayRequestContext,
  ): ReadableStream<Uint8Array>;
}

export function textToSseStream(
  eventName: string,
  stream: ReadableStream<string>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(encoder.encode(`event: ${eventName}\ndata: ${value}\n\n`));
        }
        controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}
