/**
 * Register work synchronously at socket ingress, before any asynchronous
 * permission/cache lookup can invert two frames from the same station.
 * Only StatusNotification calls use this queue; RPC results never wait on it.
 */
export class StatusIngressQueue {
  private readonly stations = new Map<string, { tail: Promise<void>; pending: number }>();

  constructor(private readonly maxPendingPerStation = 64) {}

  run<T>(station: string, work: () => Promise<T>): Promise<T> {
    const current = this.stations.get(station);
    if ((current?.pending ?? 0) >= this.maxPendingPerStation) {
      return Promise.reject(new Error('STATUS_INGRESS_BACKPRESSURE'));
    }
    const state = current ?? { tail: Promise.resolve(), pending: 0 };
    state.pending++;
    const result = state.tail.then(work);
    state.tail = result.then(() => undefined, () => undefined);
    this.stations.set(station, state);
    void state.tail.then(() => {
      state.pending--;
      if (state.pending === 0 && this.stations.get(station) === state) {
        this.stations.delete(station);
      }
    });
    return result;
  }
}
