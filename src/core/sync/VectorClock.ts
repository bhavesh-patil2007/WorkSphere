import { compareHLC, type HLCState } from "./HybridLogicalClock";

export type ClockMap = Record<string, number>;
export type VectorClockInput =
  | VectorClock
  | ReadonlyMap<string, number>
  | Readonly<Record<string, number>>;
export type VectorClockRelation = "before" | "after" | "concurrent" | "equal";
export type LegacyVectorClockRelation =
  | "BEFORE"
  | "AFTER"
  | "CONCURRENT"
  | "EQUAL";

/**
 * Tracks the causal frontier observed by one or more offline replicas.
 *
 * The legacy (nodeId, initialClock) constructor and the getClock(),
 * getNodeId(), increment(), and compareTo() methods remain available.
 */
export class VectorClock {
  private readonly clock: Map<string, number>;
  private readonly nodeId: string | null;

  constructor(nodeId: string, initialClock?: VectorClockInput);
  constructor(initialClock?: VectorClockInput);
  constructor(
    nodeIdOrClock: string | VectorClockInput = new Map<string, number>(),
    initialClock: VectorClockInput = new Map<string, number>(),
  ) {
    this.nodeId = typeof nodeIdOrClock === "string" ? nodeIdOrClock : null;
    const initial =
      typeof nodeIdOrClock === "string" ? initialClock : nodeIdOrClock;

    if (this.nodeId !== null) this.assertNodeId(this.nodeId);
    this.clock = new Map();

    for (const [node, counter] of this.entriesOf(initial)) {
      this.clock.set(node, this.validateCounter(node, counter));
    }

    if (this.nodeId !== null && !this.clock.has(this.nodeId)) {
      this.clock.set(this.nodeId, 0);
    }
  }

  private assertNodeId(nodeId: string): void {
    if (typeof nodeId !== "string" || nodeId.trim().length === 0) {
      throw new TypeError("Vector clock nodeId must be a non-empty string.");
    }
  }

  private validateCounter(nodeId: string, counter: number): number {
    this.assertNodeId(nodeId);
    if (!Number.isSafeInteger(counter) || counter < 0) {
      throw new RangeError(
        `Vector clock counter for "${nodeId}" must be a non-negative safe integer.`,
      );
    }
    return counter;
  }

  private entriesOf(input: VectorClockInput): Array<[string, number]> {
    if (input instanceof VectorClock) return [...input.clock.entries()];
    if (input instanceof Map) return [...input.entries()];
    return Object.entries(input);
  }

  /** Increment the configured local node, or an explicitly named replica. */
  public increment(): ClockMap;
  public increment(nodeId: string): number;
  public increment(nodeId?: string): ClockMap | number {
    const targetNode = nodeId ?? this.nodeId;
    if (targetNode === null || targetNode === undefined) {
      throw new Error(
        "No local nodeId is configured; pass a nodeId to increment().",
      );
    }

    this.assertNodeId(targetNode);
    const next = (this.clock.get(targetNode) ?? 0) + 1;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError(
        `Vector clock counter for "${targetNode}" exceeded the safe integer range.`,
      );
    }
    this.clock.set(targetNode, next);
    return nodeId === undefined ? this.getClock() : next;
  }

  /** Read a replica counter. Unknown replicas have an implicit value of zero. */
  public get(nodeId: string): number {
    return this.clock.get(nodeId) ?? 0;
  }

  /** Return an independent Map snapshot. */
  public toMap(): Map<string, number> {
    return new Map(this.clock);
  }

  /** Return a stable JSON-compatible snapshot with sorted replica identifiers. */
  public getClock(): ClockMap {
    return Object.fromEntries(
      [...this.clock.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  }

  public toJSON(): ClockMap {
    return this.getClock();
  }

  /** Return the configured local node id (empty only for snapshot-only clocks). */
  public getNodeId(): string {
    return this.nodeId ?? "";
  }

  public equals(other: VectorClockInput): boolean {
    const remote = new Map(this.entriesOf(other));
    const nodes = new Set([...this.clock.keys(), ...remote.keys()]);
    for (const node of nodes) {
      if ((this.clock.get(node) ?? 0) !== (remote.get(node) ?? 0)) {
        return false;
      }
    }
    return true;
  }

  /**
   * True when this clock strictly contains the causal history of the other
   * clock. Equal clocks are not considered descendants.
   */
  public descendsFrom(other: VectorClockInput): boolean {
    const remote = new Map(this.entriesOf(other));
    const nodes = new Set([...this.clock.keys(), ...remote.keys()]);
    let advanced = false;

    for (const node of nodes) {
      const localValue = this.clock.get(node) ?? 0;
      const remoteValue = remote.get(node) ?? 0;
      if (localValue < remoteValue) return false;
      if (localValue > remoteValue) advanced = true;
    }
    return advanced;
  }

  /** True only when the two causal frontiers are incomparable. */
  public isConcurrentWith(other: VectorClockInput): boolean {
    const remote = new Map(this.entriesOf(other));
    const nodes = new Set([...this.clock.keys(), ...remote.keys()]);
    let hasLower = false;
    let hasHigher = false;

    for (const node of nodes) {
      const localValue = this.clock.get(node) ?? 0;
      const remoteValue = remote.get(node) ?? 0;
      if (localValue < remoteValue) hasLower = true;
      if (localValue > remoteValue) hasHigher = true;
      if (hasLower && hasHigher) return true;
    }
    return false;
  }

  /** Compare the causal partial order without applying a timestamp tie-break. */
  public compare(other: VectorClockInput): VectorClockRelation {
    const remote = new Map(this.entriesOf(other));
    const nodes = new Set([...this.clock.keys(), ...remote.keys()]);
    let isBefore = false;
    let isAfter = false;

    for (const node of nodes) {
      const localValue = this.clock.get(node) ?? 0;
      const remoteValue = remote.get(node) ?? 0;
      if (localValue < remoteValue) isBefore = true;
      if (localValue > remoteValue) isAfter = true;
      if (isBefore && isAfter) return "concurrent";
    }

    if (isBefore) return "before";
    if (isAfter) return "after";
    return "equal";
  }

  /** Backwards-compatible uppercase relation API. */
  public compareTo(otherClock: ClockMap): LegacyVectorClockRelation {
    return this.compare(otherClock).toUpperCase() as LegacyVectorClockRelation;
  }

  /**
   * Join two causal frontiers using component-wise maxima.
   * This is an in-place semilattice merge: it does not implicitly create a new
   * local event, so merge remains idempotent. Call increment() for local edits.
   */
  public merge(other: VectorClockInput): this {
    for (const [node, counter] of this.entriesOf(other)) {
      const validCounter = this.validateCounter(node, counter);
      this.clock.set(node, Math.max(this.clock.get(node) ?? 0, validCounter));
    }
    return this;
  }

  /**
   * Deterministic conflict ordering: preserve causal BEFORE/AFTER relations;
   * use the existing HLC comparator only for concurrent or equal frontiers.
   * HLC never changes the vector clock's concurrency classification.
   */
  public compareWithHLC(
    other: VectorClockInput,
    thisTimestamp: HLCState,
    otherTimestamp: HLCState,
  ): number {
    const relation = this.compare(other);
    if (relation === "before") return -1;
    if (relation === "after") return 1;
    return compareHLC(thisTimestamp, otherTimestamp);
  }
}
