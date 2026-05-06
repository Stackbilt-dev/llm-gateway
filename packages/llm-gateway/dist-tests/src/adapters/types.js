export function textToSseStream(eventName, stream) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        async start(controller) {
            const reader = stream.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    controller.enqueue(encoder.encode(`event: ${eventName}\ndata: ${value}\n\n`));
                }
                controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
            }
            finally {
                reader.releaseLock();
                controller.close();
            }
        },
    });
}
