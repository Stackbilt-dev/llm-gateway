export function routeCandidates(routeClass, config) {
    const configured = config.routing.routes[routeClass];
    if (configured?.length)
        return configured;
    return config.routing.routes.fallback_safe;
}
