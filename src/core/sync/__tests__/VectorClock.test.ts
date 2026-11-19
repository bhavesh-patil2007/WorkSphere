import { VectorClock } from "../VectorClock";

describe("VectorClock", () => {
  it("classifies before, after, equal, and concurrent causal relationships", () => {
    const firstEdit = new VectorClock({ alice: 1 });
    const secondEdit = new VectorClock({ alice: 2 });
    const independentEdit = new VectorClock({ bob: 1 });
    const identicalEdit = new VectorClock({ alice: 1 });

    expect(firstEdit.compare(secondEdit)).toBe("before");
    expect(secondEdit.compare(firstEdit)).toBe("after");
    expect(firstEdit.compare(identicalEdit)).toBe("equal");
    expect(firstEdit.compare(independentEdit)).toBe("concurrent");
    expect(firstEdit.equals(identicalEdit)).toBe(true);
  });

  it("detects a strict descendant across a three-peer causal history", () => {
    const peerA = new VectorClock({ alice: 2 });
    const peerB = new VectorClock({ alice: 2, bob: 1 });
    const peerC = new VectorClock({ alice: 2, bob: 1, carol: 3 });

    expect(peerB.descendsFrom(peerA)).toBe(true);
    expect(peerC.descendsFrom(peerA)).toBe(true);
    expect(peerC.descendsFrom(peerB)).toBe(true);
    expect(peerA.descendsFrom(peerB)).toBe(false);
    expect(peerA.descendsFrom(peerA)).toBe(false);
  });

  it("detects true concurrency when each peer has an unseen event", () => {
    const peerA = new VectorClock({ alice: 3, bob: 1 });
    const peerB = new VectorClock({ alice: 2, bob: 2, carol: 1 });

    expect(peerA.isConcurrentWith(peerB)).toBe(true);
    expect(peerB.isConcurrentWith(peerA)).toBe(true);
    expect(peerA.descendsFrom(peerB)).toBe(false);
    expect(peerB.descendsFrom(peerA)).toBe(false);
  });

  it("treats missing replica entries as zero", () => {
    const empty = new VectorClock();
    const peerA = new VectorClock({ alice: 1 });
    const peerB = new VectorClock({ bob: 1 });

    expect(peerA.compare(empty)).toBe("after");
    expect(empty.compare(peerA)).toBe("before");
    expect(peerA.isConcurrentWith(peerB)).toBe(true);
  });

  it("increments independent peer counters without mutating snapshots", () => {
    const clock = new VectorClock();
    expect(clock.increment("alice")).toBe(1);
    expect(clock.increment("alice")).toBe(2);
    expect(clock.increment("bob")).toBe(1);
    expect(clock.toJSON()).toEqual({ alice: 2, bob: 1 });

    const snapshot = clock.toMap();
    snapshot.set("alice", 100);
    expect(clock.get("alice")).toBe(2);
  });

  it("merges component-wise maxima and is idempotent, commutative, and associative", () => {
    const a = new VectorClock({ alice: 2 });
    const b = new VectorClock({ bob: 4 });
    const c = new VectorClock({ alice: 1, carol: 3 });

    const mergedAB = new VectorClock(a).merge(b);
    const mergedBA = new VectorClock(b).merge(a);
    expect(mergedAB.toJSON()).toEqual({ alice: 2, bob: 4 });
    expect(mergedAB.toJSON()).toEqual(mergedBA.toJSON());

    const beforeRepeat = mergedAB.toJSON();
    mergedAB.merge(b);
    expect(mergedAB.toJSON()).toEqual(beforeRepeat);

    const leftAssociated = new VectorClock(a).merge(b).merge(c);
    const rightAssociated = new VectorClock(a).merge(new VectorClock(b).merge(c));
    expect(leftAssociated.toJSON()).toEqual(rightAssociated.toJSON());
  });

  it("round-trips a stable JSON snapshot", () => {
    const original = new VectorClock({ "peer-z": 4, "peer-a": 1, "peer-b": 2 });
    const encoded = JSON.stringify(original);
    const restored = new VectorClock(JSON.parse(encoded));

    expect(encoded).toBe('{"peer-a":1,"peer-b":2,"peer-z":4}');
    expect(restored.equals(original)).toBe(true);
  });

  it("uses HLC timestamps only as a deterministic tie-break for concurrent clocks", () => {
    const peerA = new VectorClock({ alice: 1 });
    const peerB = new VectorClock({ bob: 1 });
    const stampA = { pt: 1000, lc: 2, nodeId: "peer-a" };
    const stampB = { pt: 1000, lc: 2, nodeId: "peer-b" };

    expect(peerA.isConcurrentWith(peerB)).toBe(true);
    expect(peerA.compareWithHLC(peerB, stampA, stampB)).toBeLessThan(0);
    expect(peerB.compareWithHLC(peerA, stampB, stampA)).toBeGreaterThan(0);
  });

  it("never lets a newer HLC override an established causal ordering", () => {
    const ancestor = new VectorClock({ alice: 4 });
    const descendant = new VectorClock({ alice: 4, bob: 1 });
    const olderHlc = { pt: 1000, lc: 0, nodeId: "peer-a" };
    const newerHlc = { pt: 9000, lc: 0, nodeId: "peer-b" };

    expect(descendant.compareWithHLC(ancestor, olderHlc, newerHlc)).toBe(1);
    expect(ancestor.compareWithHLC(descendant, newerHlc, olderHlc)).toBe(-1);
  });

  it("uses HLC tie-breaking for identical vector snapshots from distinct events", () => {
    const left = new VectorClock({ alice: 1 });
    const right = new VectorClock({ alice: 1 });

    expect(
      left.compareWithHLC(
        right,
        { pt: 1000, lc: 0, nodeId: "peer-a" },
        { pt: 1000, lc: 0, nodeId: "peer-b" },
      ),
    ).toBeLessThan(0);
  });

  it("rejects empty node ids, negative counters, unsafe counters, and counter overflow", () => {
    expect(() => new VectorClock({ "": 1 })).toThrow("non-empty string");
    expect(() => new VectorClock({ alice: -1 })).toThrow("non-negative safe integer");
    expect(() => new VectorClock({ alice: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      "non-negative safe integer",
    );

    const clock = new VectorClock({ alice: Number.MAX_SAFE_INTEGER });
    expect(() => clock.increment("alice")).toThrow("safe integer range");
  });
});
