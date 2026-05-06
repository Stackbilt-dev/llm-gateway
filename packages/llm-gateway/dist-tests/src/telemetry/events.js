export class EventStore {
    events = [];
    append(event) {
        this.events.push(event);
        if (this.events.length > 5000)
            this.events.shift();
    }
    recent(limit = 100) {
        return this.events.slice(-limit).reverse();
    }
    all() {
        return [...this.events];
    }
}
