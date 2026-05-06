export function buildMetrics(events) {
    let latencyTotal = 0;
    let successCount = 0;
    let errorCount = 0;
    let fallbackSuccessCount = 0;
    let estimatedCostUsd = 0;
    const byProvider = {};
    const byRouteClass = {};
    for (const event of events) {
        latencyTotal += event.latencyMs;
        byProvider[event.selectedProvider] = (byProvider[event.selectedProvider] ?? 0) + 1;
        byRouteClass[event.routeClass] = (byRouteClass[event.routeClass] ?? 0) + 1;
        estimatedCostUsd += event.costEstimateUsd ?? 0;
        if (event.status === "success")
            successCount += 1;
        if (event.status === "error")
            errorCount += 1;
        if (event.status === "fallback_success")
            fallbackSuccessCount += 1;
    }
    return {
        totalRequests: events.length,
        successCount,
        errorCount,
        fallbackSuccessCount,
        avgLatencyMs: events.length === 0 ? 0 : Math.round((latencyTotal / events.length) * 100) / 100,
        byProvider,
        byRouteClass,
        estimatedCostUsd: Math.round(estimatedCostUsd * 100000) / 100000,
    };
}
